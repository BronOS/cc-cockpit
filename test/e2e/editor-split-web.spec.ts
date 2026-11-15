// Page panes in browser views and server mode (docs/design-split-pages.md §7, plan Task 9): the
// desktop places a file beside Claude; a plain browser draws both panes with its own frame at the
// pane's box, a Ctrl+W typed in that frame closes the file (the web chord carries the frame's tab),
// two visible frames survive a web reconnect, and server mode's hidden page mounts no frame while
// Close all with a dirty file asks in the browser (ApprovalDialog).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import type { HostStatus } from "../../src/main/plugins/host-manager";
import { expect, launchCockpit, test, type Cockpit } from "./fixtures";
import { launchServer, type Server } from "./server-fixtures";
import {
  enableWebAccess,
  openBrowser,
  openProjectInBrowser,
  type WebBrowser,
} from "./web-fixtures";
import {
  groupFor,
  MOD,
  paneOf,
  place,
  roomyDesktop,
  tabsOf,
  visiblePanes,
} from "./split-fixtures";

async function pluginActive(c: Cockpit, id: string): Promise<void> {
  await expect
    .poll(
      async () =>
        (await c.hook<HostStatus>("hostStatus", c.projectDir)).plugins.find(
          (p) => p.id === id,
        )?.state,
      { timeout: 15_000 },
    )
    .toBe("active");
}

/** Opens `name` as a page tab from the Files panel of `page` (the desktop's or a browser's) and returns its tab id. */
async function openFile(page: Page, name: string): Promise<string> {
  const section = page.locator('section.panel[aria-label="Files"]');
  if (!(await section.isVisible()))
    await page
      .locator(".zone-left")
      .getByRole("button", { name: /^Files/ })
      .click();
  const tree = page.frameLocator('section.panel[aria-label="Files"] iframe');
  const row = tree.locator(".row", {
    has: tree.locator(".name", {
      hasText: new RegExp(`^${name.replace(".", "\\.")}$`),
    }),
  });
  await row.hover();
  await row.getByRole("button", { name: "Edit" }).click();
  await expect
    .poll(
      async () =>
        (await tabsOf(page)).find(
          (t) => t.kind === "page" && t.page?.title === name,
        )?.id,
      { timeout: 20_000 },
    )
    .toBeTruthy();
  return (await tabsOf(page)).find(
    (t) => t.kind === "page" && t.page?.title === name,
  )!.id;
}

const frameEl = (page: Page, title: string) =>
  page.locator(`iframe.page-tab-frame[title="${title}"]`);

async function pageIn(page: Page, title: string) {
  const handle = await frameEl(page, title).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame for ${title}`);
  await expect(frame.locator(".cm-content")).toBeVisible({ timeout: 20_000 });
  return frame;
}

/** Whether the frame of `title` lies inside the pane of `tabId`, below its header. */
async function inBox(
  page: Page,
  title: string,
  tabId: string,
): Promise<boolean> {
  const pane = paneOf(page, tabId);
  const [f, p, h] = [
    await frameEl(page, title).boundingBox(),
    await pane.boundingBox(),
    await pane.locator("[data-pane-header]").boundingBox(),
  ];
  if (!f || !p || !h) return false;
  return (
    f.x >= p.x - 0.5 &&
    f.x + f.width <= p.x + p.width + 0.5 &&
    f.y >= h.y + h.height - 0.5 &&
    f.y + f.height <= p.y + p.height + 0.5
  );
}

type Marked = { __splitMark?: string };
const markOf = (frame: Awaited<ReturnType<typeof pageIn>>) =>
  frame.evaluate(() => (window as unknown as Marked).__splitMark);
const setMark = (frame: Awaited<ReturnType<typeof pageIn>>, v: string) =>
  frame.evaluate((m) => {
    (window as unknown as Marked).__splitMark = m;
  }, v);

test("web view: a file beside Claude is two panes in the browser, its frame in the pane box; two frames survive a reconnect; Ctrl+W in a frame closes its file", async () => {
  test.setTimeout(150_000);
  const { cockpit: c, close } = await launchCockpit({
    env: { CC_COCKPIT_NO_BUNDLED: "" },
  });
  let browser: WebBrowser | undefined;
  try {
    const { page, projectDir } = c;
    await roomyDesktop(c);
    writeFileSync(join(projectDir, "notes.txt"), "one\ntwo\n");
    writeFileSync(join(projectDir, "other.txt"), "uno\ndos\n");
    const web = await enableWebAccess(c);
    await c.newTab("claude");
    await c.waitForTerminalText("FAKE-CLAUDE banner");
    const claude = (await tabsOf(page)).find((t) => t.kind === "claude")!.id;
    await pluginActive(c, "cockpit.editor");
    await pluginActive(c, "cockpit.files");
    const file = await openFile(page, "notes.txt");
    const other = await openFile(page, "other.txt");
    expect((await place(page, file, claude, "right")).ok).toBe(true);
    await page.getByRole("tab", { name: /notes\.txt/ }).click();
    await expect(visiblePanes(page)).toHaveCount(2);
    const desktopFrame = await pageIn(page, "notes.txt");
    await setMark(desktopFrame, "desktop");

    browser = await openBrowser(web.link);
    const w = browser.page;
    // A roomy window (as split-views.spec.ts): a small one auto-zooms the group (D5).
    await browser.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1900, 1000),
    );
    await roomyDesktop(c);
    // Keep a handle on every socket the page opens (passed through), to drop them later.
    const sockets: WebSocketRoute[] = [];
    await w.routeWebSocket(/.*/, (ws) => {
      ws.connectToServer();
      sockets.push(ws);
    });
    const projects = w
      .getByRole("list", { name: "Open projects" })
      .getByRole("link");
    await expect(projects).toHaveCount(1);
    await projects.click();
    await expect(w.locator(".tabs-pane")).toBeVisible();
    // Both panes drawn once groups.get has answered; the browser's frame lies in the file pane's box.
    await expect(visiblePanes(w)).toHaveCount(2, { timeout: 20_000 });
    await expect(paneOf(w, claude).locator(".xterm")).toBeVisible();
    const webFrame = await pageIn(w, "notes.txt");
    await expect.poll(() => inBox(w, "notes.txt", file)).toBe(true);
    await setMark(webFrame, "web");

    // A second file beside the first: two frames visible in the browser at once.
    expect((await place(page, other, file, "right")).ok).toBe(true);
    await expect(visiblePanes(w)).toHaveCount(3, { timeout: 20_000 });
    const otherFrame = await pageIn(w, "other.txt");
    await expect.poll(() => inBox(w, "other.txt", other)).toBe(true);
    await setMark(otherFrame, "web-other");

    // A web reconnect: the shell's sockets are closed from the routed handle (a real drop, unlike
    // going offline) and come back; the frames take a new port and both marks stay (no reload).
    for (const f of [webFrame, otherFrame])
      await f.evaluate(() => {
        const w = window as unknown as { __ports?: number };
        w.__ports = 0;
        window.addEventListener("message", (e) => {
          if (e.ports.length > 0) w.__ports = (w.__ports ?? 0) + 1;
        });
      });
    const before = sockets.length;
    expect(before).toBeGreaterThan(0);
    for (const s of [...sockets]) await s.close();
    await expect
      .poll(() => sockets.length, { timeout: 30_000 })
      .toBeGreaterThan(before);
    await expect(visiblePanes(w)).toHaveCount(3, { timeout: 30_000 });
    for (const f of [webFrame, otherFrame])
      await expect
        .poll(
          () =>
            f.evaluate(
              () => (window as unknown as { __ports?: number }).__ports,
            ),
          {
            timeout: 30_000,
          },
        )
        .toBeGreaterThan(0);
    expect(await markOf(webFrame)).toBe("web");
    expect(await markOf(otherFrame)).toBe("web-other");
    expect(await markOf(desktopFrame)).toBe("desktop");

    // Ctrl+W typed in the browser's frame of `other` closes that file; the desktop's frame is untouched.
    await paneOf(w, other).locator("[data-pane-header]").hover();
    await otherFrame.locator(".cm-line", { hasText: "uno" }).click();
    await w.keyboard.press(`${MOD}+Alt+w`);
    await expect
      .poll(async () => (await tabsOf(page)).some((t) => t.id === other), {
        timeout: 15_000,
      })
      .toBe(false);
    expect((await tabsOf(page)).some((t) => t.id === file)).toBe(true);
    expect(await markOf(desktopFrame)).toBe("desktop");
    expect(await groupFor(page, file)).toBeDefined();
  } finally {
    await browser?.close();
    await close();
  }
});

let server: Server | undefined;
test.afterEach(async () => {
  await server?.close();
  server = undefined;
});

test("server mode: a file pane in a group mounts no frame in the hidden page; Close all with a dirty file asks in the browser", async () => {
  test.skip(process.platform !== "linux", "server mode is Linux only");
  test.setTimeout(150_000);
  server = await launchServer({
    env: { CC_COCKPIT_NO_BUNDLED: "" },
    settings: {
      pluginSettings: {
        "cockpit.editor": { autosaveIdleSeconds: 0, autosaveOnBlur: false },
      },
    },
  });
  const { cockpit } = server;
  writeFileSync(join(cockpit.projectDir, "a.txt"), "alpha\n");
  await pluginActive(cockpit, "cockpit.editor");
  await pluginActive(cockpit, "cockpit.files");
  const browser = await openBrowser(`${server.origin}/`);
  try {
    const w = browser.page;
    await browser.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.setSize(1900, 1000),
    );
    await expect.poll(() => w.evaluate(() => innerWidth)).toBeGreaterThan(1500);
    await openProjectInBrowser(browser, server.origin, server.projectId);
    const hiddenFrames = cockpit.page.locator("iframe.page-tab-frame");
    await expect(hiddenFrames).toHaveCount(0);
    // Through the page's own menu: a page adds its own tab from the reply (a raw invoke leaves it out).
    await w.getByRole("button", { name: "New tab" }).click();
    await w.getByRole("menuitem", { name: "Claude" }).click();
    await expect
      .poll(async () => (await tabsOf(w)).some((t) => t.kind === "claude"), {
        timeout: 20_000,
      })
      .toBe(true);
    const claude = (await tabsOf(w)).find((t) => t.kind === "claude")!.id;
    const file = await openFile(w, "a.txt");
    // The file tab is selected in the hidden page too (opening selects it): still no frame there.
    await expect(hiddenFrames).toHaveCount(0);
    expect((await place(w, file, claude, "right")).ok).toBe(true);
    await w.getByRole("tab", { name: /a\.txt/ }).click();
    await expect(visiblePanes(w)).toHaveCount(2, { timeout: 20_000 });
    const frame = await pageIn(w, "a.txt");
    // The hidden page draws the sections and mounts no page frame.
    await expect(hiddenFrames).toHaveCount(0);
    await paneOf(w, file).locator("[data-pane-header]").hover();
    await frame.locator(".cm-line", { hasText: "alpha" }).click();
    await w.keyboard.type("Q");
    await expect
      .poll(
        async () =>
          (
            await cockpit.hook<Array<{ id: string; dirty?: boolean }>>(
              "tabs",
              cockpit.projectDir,
            )
          ).find((t) => t.id === file)?.dirty,
      )
      .toBe(true);

    await w.locator("[data-group-handle]").first().click({ button: "right" });
    await w.getByRole("menuitem", { name: "Close all" }).click();
    const dialog = w.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("a.txt");
    // The approval arms after about a second of visibility.
    const discard = dialog.getByRole("button", {
      name: /Discard and Close all/,
    });
    await expect(discard).toBeEnabled({ timeout: 10_000 });
    await discard.click();
    await expect
      .poll(async () => (await tabsOf(w)).length, { timeout: 15_000 })
      .toBe(0);
  } finally {
    await browser.close();
  }
});
