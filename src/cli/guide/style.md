# Style: the component stylesheet

Every page that loads `/__sdk/panel.js` (panels, html overlays, slots, html settings pages) gets the
app's component stylesheet, so a plugin page looks like the app and like other plugins. Use the
components; draw your own control only where none fits (a timeline, a diff), and then still with the
tokens below. Url overlays and web views show foreign sites and get nothing.

All rules sit in `@layer cc`: unlayered CSS beats any layer whatever its specificity, so your own rule
always wins and you never need `!important`. Bare `button`, `input`, `textarea` and `select` are
styled too. A page that styles `button` only in part (a colour, no border) now shows the layer's
border under its rule: set `border` yourself or use the classes.

Colours come only from the theme variables (`ccc guide panels`, "Theme variables"); themes are
colour-only, so sizes are fixed.

## Tokens

- Spacing: `--cc-space-1..6` = 4, 8, 12, 16, 24, 32 px.
- Radii: `--cc-radius-s` 4 px, `--cc-radius-m` 6 px, `--cc-radius-l` 10 px (a settings card).
- Text: `--cc-text-s` 11 px, `--cc-text-m` 13 px (the default), `--cc-text-l` 15 px.
- Sizes: `--cc-control-h` 26 px, `--cc-row-h` 36 px, `--cc-row-h-compact` 28 px.
- Fonts: `--cc-font-ui`, `--cc-font-mono`.

## Buttons

```html
<button>Refresh</button>
<button class="cc-primary">Save</button>
<button class="cc-danger">Delete</button>
<button class="cc-ghost">Cancel</button>
<button class="cc-icon" title="Refresh"><svg viewBox="0 0 24 24">...</svg></button>
<a class="cc-btn" href="#">Looks like a button</a>
```

`.cc-btn` gives any element the button look; `.cc-primary` is the one action the view is for (one per
view); `.cc-danger` is a destructive action; `.cc-ghost` has no frame; `.cc-icon` is a square 26 px
button with a 16 px icon and needs a `title`.

## Inputs and fields

```html
<div class="cc-field">
  <label for="name">Name</label>
  <input id="name" type="text" placeholder="Name">
  <span class="cc-help">Shown in the list.</span>
  <span class="cc-error">Required.</span>
</div>
```

Inputs, selects, textareas, checkboxes and radios need no class. `.cc-field` lays out a label, the
control, `.cc-help` and `.cc-error`. A panel has no settings form: settings belong to the app's
Settings screen (`ccc guide settings-secrets`).

## Card

```html
<div class="cc-card"><h3 class="cc-card-title">Account</h3>...</div>
```

A framed block that is not a list item, in a panel or an overlay. Not on a settings page (next).

## Settings page

An html settings page (`ccc guide settings-secrets`) sits under the app's own schema form, so it
uses the app's settings look: each section is a group, its title and description above a card, and
inside the card one row per setting, label and help on the left, the control on the right, a hairline
between rows.

```html
<section class="cc-settings-group">
  <div class="cc-settings-head">
    <h3>Agenda</h3>
    <p class="cc-settings-desc">Today's events, in a strip of the panel.</p>
    <div class="cc-settings-actions"><button>Reset</button></div>
  </div>
  <div class="cc-settings-card">
    <div class="cc-settings-card-head">Optional head line</div>
    <div class="cc-settings-row">
      <div class="cc-settings-row-text">
        <label class="cc-settings-label" for="where">Where it goes</label>
        <span class="cc-settings-help">Above or below the list.</span>
      </div>
      <div class="cc-settings-control"><select id="where">...</select></div>
    </div>
    <ul class="cc-settings-list"><li class="cc-settings-row">...</li></ul>
  </div>
</section>
```

A list of editable items (names with checkboxes and buttons) is a grid in the card, so every row's
controls line up: name the columns in `--cc-settings-cols` (one track per control, `minmax(0, 1fr)`
for the one that takes the room; an `auto` track is as wide as its widest cell in any row), and make
each row a `.cc-settings-item`. Any other child of the grid (the editor of the open item, an empty
state) spans the whole width; a cell that should span some columns sets `grid-column` itself. Put
the add field and button in the card's last row, in the same columns.

```html
<ul class="cc-settings-grid" style="--cc-settings-cols: minmax(0, 1fr) auto auto">
  <li class="cc-settings-item"><input aria-label="Name" value="Urgent"><label><input type="checkbox"> Badge</label><button class="cc-danger">Delete</button></li>
  <li class="cc-settings-item"><input aria-label="New name" placeholder="New name"><button style="grid-column: 2 / -1; justify-self: start">Add</button></li>
</ul>
```

## List and rows

```html
<ul class="cc-list">
  <li class="cc-row cc-unread" tabindex="0">
    <div class="cc-row-main">
      <span class="cc-row-title">Title</span>
      <span class="cc-row-meta">Meta</span>
    </div>
    <span class="cc-row-actions"><button class="cc-icon" title="Done">...</button></span>
  </li>
</ul>
```

Every list of items is rows. `aria-selected="true"` marks the selected row, `.cc-unread` bolds the
title and adds a dot, `.cc-compact` (on the list or one row) uses the 28 px height. The actions show on
hover and while focus is in the row.

## Group header

```html
<details class="cc-group" open>
  <summary class="cc-group-title">Today <span class="cc-count">3</span></summary>
  ...rows...
</details>
<div class="cc-group"><div class="cc-group-title">Later</div>...</div>
```

## Chip and badge

```html
<button class="cc-chip" aria-pressed="true">Unread</button>
<span class="cc-badge blue">new</span>
```

A chip is a filter or toggle (`aria-pressed`). A badge is a short tag; colours `green red blue amber
violet grey`.

## Toolbar and tabs

```html
<div class="cc-toolbar"><input type="search"><button class="cc-primary">Add</button></div>
<div class="cc-tabs" role="tablist"><button role="tab" aria-selected="true">All</button></div>
```

## States

```html
<div class="cc-empty"><p>No messages. Nothing needs you.</p><button>Refresh</button></div>
<span class="cc-spinner"></span>
<div class="cc-error-line">Could not load: offline.</div>
<span class="cc-muted">quiet text</span> <kbd class="cc-kbd">Esc</kbd>
```

## Rules

- Rows for items, cards for a block that is not an item.
- An html settings page uses the settings classes (`.cc-settings-group`, `.cc-settings-card`,
  `.cc-settings-row`), not `.cc-card`: titles above the card, controls in rows.
- One primary button per view.
- An overlay has one action bar, the app's toolbar: a page draws no close button and no footer of
  actions. Its actions are overlay `buttons` (`primary: true` for the main one), and ✕ / Esc close.
- A page that wants the person's words before Discuss keeps its own field and returns them from
  `onDiscuss` (the reviewer's comment is the example); Discuss itself has no note field.
- A destructive action asks first or offers undo.
- Empty, loading and error states are always drawn: `.cc-empty` says why it is empty and what to do.
- Sentence case labels ("Mark as read", not "Mark As Read").
- Every icon-only control has a `title` (its tooltip and accessible name).
- Everything is reachable by keyboard and shows a visible focus.
- No settings forms in a panel; they go to the Settings screen.
- Own controls only where no component fits, still with the tokens and theme colours.
