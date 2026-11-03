// The settings form's own rjsf templates and the `multiline` widget (PluginSettingsForm.tsx).
// rjsf's core templates assume Bootstrap 3, which this app does not load: its array buttons are
// glyphicon `<i>`s that drew as empty squares, its item rows lean on `col-xs-*` widths (so an
// array item's fields got a narrower label column than the rest of the form) and its add button
// floats in a `row`. These draw the same structure with the settings screen's buttons and glyphs,
// and give every level the one label / field layout of the `.settings-plugin-form` rules.

// Deep imports, as the Form's in PluginSettingsForm.tsx (the package root would bundle ajv).
import SelectWidget from '@rjsf/core/lib/components/widgets/SelectWidget.js'
import TextareaWidget from '@rjsf/core/lib/components/widgets/TextareaWidget.js'
import {
  buttonId,
  descriptionId,
  getUiOptions,
  titleId,
  type ArrayFieldItemTemplateProps,
  type ArrayFieldTemplateProps,
  type IconButtonProps,
  type RJSFSchema,
  type TemplatesType,
  type TitleFieldProps,
  type WidgetProps
} from '@rjsf/utils'
import { createContext, useContext } from 'react'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrashIcon } from './icons'

/**
 * The id rjsf gives the root object's title (`titleId` of the default `idPrefix`, "root"). The root
 * title is not drawn: the plugin's row above the form already names it. It stays in the DOM as the
 * fieldset's legend, so the form keeps its accessible name.
 */
const ROOT_TITLE_ID = 'root__title'

/**
 * Titles of arrays and nested objects, as a heading over their description. rjsf's own template
 * draws a `<legend>` too; the stylesheet used to hide every legend (the root one repeated the
 * plugin's name), which took "Rules" and every group's title away with it.
 */
function TitleFieldTemplate(props: TitleFieldProps): React.JSX.Element {
  return (
    <legend id={props.id} className={props.id === ROOT_TITLE_ID ? 'visually-hidden' : 'settings-form-title'}>
      {props.title}
      {props.required === true && <span className="required">*</span>}
      {props.optionalDataControl}
    </legend>
  )
}

/** What an array's items call themselves in their buttons' names: set by the array, read by each item. */
interface ArrayNames {
  /** The array's title ("Rules"). */
  owner: string
  /** The `items` schema's own title ("Rule"), when it has one: then the buttons say "Add Rule", "Remove Rule 2". */
  item?: string
}
// A context rather than a prop: rjsf builds the item elements before the array template sees them,
// and they render inside its provider.
const ArrayNamesContext = createContext<ArrayNames>({ owner: 'list' })

function itemTitleOf(schema: RJSFSchema): string | undefined {
  const items = schema.items
  if (typeof items !== 'object' || items === null || Array.isArray(items)) return undefined
  const title = (items as RJSFSchema).title
  return typeof title === 'string' && title.trim() !== '' ? title : undefined
}

/**
 * An array: its title and description, the items, then Add. The title and description are drawn
 * here, not through rjsf's ArrayFieldTitle/DescriptionTemplate: those only add the `ui:label` and
 * markdown options of a uiSchema, and a manifest brings none.
 */
function ArrayFieldTemplate(props: ArrayFieldTemplateProps): React.JSX.Element {
  const { schema, fieldPathId } = props
  const uiOptions = getUiOptions(props.uiSchema)
  const owner = (typeof uiOptions.title === 'string' && uiOptions.title) || props.title || 'list'
  const item = itemTitleOf(schema)
  const off = props.disabled === true || props.readonly === true
  const description = (typeof uiOptions.description === 'string' && uiOptions.description) || schema.description
  return (
    <fieldset className={`${props.className ?? ''} settings-form-array`} id={fieldPathId.$id}>
      <TitleFieldTemplate
        id={titleId(fieldPathId)}
        title={owner}
        {...(props.required !== undefined ? { required: props.required } : {})}
        schema={schema}
        registry={props.registry}
        optionalDataControl={off ? undefined : props.optionalDataControl}
      />
      {description !== undefined && description !== '' && (
        <div id={descriptionId(fieldPathId)} className="field-description">
          {description}
        </div>
      )}
      {off ? props.optionalDataControl : null}
      {props.items.length > 0 && (
        <ArrayNamesContext.Provider value={item !== undefined ? { owner, item } : { owner }}>
          <div className="settings-form-items">{props.items}</div>
        </ArrayNamesContext.Provider>
      )}
      {props.canAdd === true && (
        <div className="settings-form-add">
          <button
            type="button"
            id={buttonId(fieldPathId, 'add')}
            className="rjsf-array-item-add"
            aria-label={item !== undefined ? `Add ${item}` : `Add to ${owner}`}
            disabled={off}
            onClick={props.onAddClick}
          >
            <PlusIcon size={14} />
            {item !== undefined ? `Add ${item}` : 'Add'}
          </button>
        </div>
      )}
    </fieldset>
  )
}

/** An item that is a group of fields (an object, a nested array) gets a box with a header; a single value is a row. */
function isGroup(schema: RJSFSchema): boolean {
  return schema.type === 'object' || schema.type === 'array' || schema.properties !== undefined
}

/**
 * One array item. An object item is a box: a header with its number and its buttons, then its
 * fields. A single value (an array of strings) is one row: the field, then the buttons. The
 * buttons are the settings screen's icon buttons (TabCommandsEditor), named for the item.
 */
function ArrayFieldItemTemplate(props: ArrayFieldItemTemplateProps): React.JSX.Element {
  const names = useContext(ArrayNamesContext)
  const n = props.index + 1
  const named = names.item !== undefined ? `${names.item} ${n}` : `${names.owner} item ${n}`
  const b = props.buttonsProps
  const off = b.disabled === true || b.readonly === true
  const toolbar = props.hasToolbar ? (
    <div className="settings-form-item-buttons">
      {(b.hasMoveUp || b.hasMoveDown) && (
        <>
          <button
            type="button"
            id={buttonId(b.fieldPathId, 'moveUp')}
            className="icon quiet rjsf-array-item-move-up"
            aria-label={`Move ${named} up`}
            title="Move up"
            disabled={off || !b.hasMoveUp}
            onClick={b.onMoveUpItem}
          >
            <ArrowUpIcon size={14} />
          </button>
          <button
            type="button"
            id={buttonId(b.fieldPathId, 'moveDown')}
            className="icon quiet rjsf-array-item-move-down"
            aria-label={`Move ${named} down`}
            title="Move down"
            disabled={off || !b.hasMoveDown}
            onClick={b.onMoveDownItem}
          >
            <ArrowDownIcon size={14} />
          </button>
        </>
      )}
      {b.hasCopy && (
        <button
          type="button"
          id={buttonId(b.fieldPathId, 'copy')}
          className="quiet rjsf-array-item-copy"
          aria-label={`Copy ${named}`}
          disabled={off}
          onClick={b.onCopyItem}
        >
          Copy
        </button>
      )}
      {b.hasRemove && (
        <button
          type="button"
          id={buttonId(b.fieldPathId, 'remove')}
          className="icon quiet danger rjsf-array-item-remove"
          aria-label={`Remove ${named}`}
          title="Remove"
          disabled={off}
          onClick={b.onRemoveItem}
        >
          <TrashIcon size={14} />
        </button>
      )}
    </div>
  ) : null
  if (isGroup(props.schema)) {
    return (
      <div className={`${props.className} settings-form-item settings-form-item-group`}>
        <div className="settings-form-item-head">
          <span className="settings-form-item-title">{named}</span>
          {toolbar}
        </div>
        {props.children}
      </div>
    )
  }
  return (
    <div className={`${props.className} settings-form-item settings-form-item-row`}>
      <div className="settings-form-item-body">{props.children}</div>
      {toolbar}
    </div>
  )
}

/**
 * rjsf's button templates, for the places that still take them from the registry (an object with
 * `additionalProperties` gets Add and, per key, Remove; the optional-data controls): visible text
 * or a glyph with a name, never the empty glyphicon square.
 */
function textButton(label: string, glyph: React.ReactNode, extraClass: string): React.ComponentType<IconButtonProps> {
  function TemplateButton(props: IconButtonProps): React.JSX.Element {
    // Only the button's own attributes: the rest of the props (registry, uiSchema, icon) are rjsf's.
    const { id, onClick, disabled, style, className } = props
    return (
      <button
        type="button"
        id={id}
        title={label}
        className={`${extraClass} ${className ?? ''}`.trim()}
        onClick={onClick}
        disabled={disabled}
        style={style}
      >
        {glyph}
        {extraClass.includes('icon') ? <span className="visually-hidden">{label}</span> : label}
      </button>
    )
  }
  return TemplateButton
}

/**
 * The `multiline` widget: rjsf's textarea, four rows to start, growing with its text (the
 * stylesheet). A format's widget wins over the enum's drop-down in rjsf, so a property with both
 * keeps its drop-down: a textarea would let any text be typed for a closed set of choices.
 */
function MultilineWidget(props: WidgetProps): React.JSX.Element {
  if (Array.isArray(props.options.enumOptions)) return <SelectWidget {...props} />
  return <TextareaWidget {...props} options={{ ...props.options, rows: 4 }} />
}

export const formTemplates: Partial<Omit<TemplatesType, 'ButtonTemplates'>> & {
  ButtonTemplates: Partial<TemplatesType['ButtonTemplates']>
} = {
  TitleFieldTemplate,
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  ButtonTemplates: {
    AddButton: textButton('Add', <PlusIcon size={14} />, ''),
    RemoveButton: textButton('Remove', <TrashIcon size={14} />, 'icon quiet danger'),
    MoveUpButton: textButton('Move up', <ArrowUpIcon size={14} />, 'icon quiet'),
    MoveDownButton: textButton('Move down', <ArrowDownIcon size={14} />, 'icon quiet'),
    CopyButton: textButton('Copy', null, 'quiet'),
    ClearButton: textButton('Clear', null, 'quiet')
  }
}

/**
 * The widgets rjsf picks by a string property's `format` (a format with a registered widget of
 * the same name wins over the text input). `multiline` is ignored by main's validator (ajv with
 * `validateFormats: false`, validate.ts), so it is a form hint only and allowed anywhere.
 */
export const formatWidgets = { multiline: MultilineWidget }
