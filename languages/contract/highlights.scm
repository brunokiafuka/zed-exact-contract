; Highlighting for Exact Contract.
;
; The grammar is line-oriented and keyword-free on purpose (see grammar/grammar.js),
; so keywords, tags and declarations are recognised here. In Zed a later pattern
; wins over an earlier one, so this file runs from general to specific.
; The tag and command lists between the `generated` markers come from
; `contract vocab --json --all`: `scripts/gen-highlights.py` rewrites them.

(comment) @comment

(string) @string
(template) @string
(escape) @string.escape
(interpolation) @embedded
(interpolation "${" @punctuation.special)
(interpolation "}" @punctuation.special)

(number) @number
(operator) @operator
(delimiter) @punctuation.delimiter
["(" ")" "[" "]" "{" "}"] @punctuation.bracket

(identifier) @variable

((identifier) @type
  (#match? @type "^[A-Z]"))

((identifier) @type.builtin
  (#any-of? @type.builtin "number" "string" "bool" "action" "option"))

((identifier) @boolean
  (#any-of? @boolean "true" "false"))

((identifier) @constant.builtin
  (#eq? @constant.builtin "none"))

; Words that are keywords wherever they stand in a line.
((identifier) @keyword
  (#any-of? @keyword
    "and" "or" "not" "in" "as" "shape" "when" "then" "refreshes" "with" "from" "else" "mount"
    "match" "case" "key"))

(member "." @punctuation.delimiter)
(member property: (identifier) @property)

; `gap=8`, and an assignment's target.
(attribute name: (identifier) @attribute)
(attribute "=" @operator)

; Calls: a function, a host command, a component.
(call function: (identifier) @function)

((call function: (identifier) @function.builtin)
  (#any-of? @function.builtin
    ; generated: commands
    "blur" "copyText" "deliveryActivate" "deliveryCheck" "fastSeek" "focus" "format" "haptic"
    "openURL" "load" "requestFullscreen" "exitFullscreen" "requestPictureInPicture"
    "exitPictureInPicture" "reload" "navigate" "traverseHistory" "stopLoading"
    "captureScreenshot" "openDevTools" "relaunch" "removeAllRanges" "selectText"
    "setSelectionRange" "setRangeText" "setScheme" "setRootFontSize" "setPageZoom" "setMode"
    "showPicker" "startTrace_EXPERIMENTAL" "stopTrace_EXPERIMENTAL" "showModal" "showPopover"
    "hidePopover" "togglePopover" "share" "saveFile" "showOpenFilePicker" "showDirectoryPicker"
    "showSaveFilePicker" "requestPermission" "scrollIntoView" "scrollBy" "postMessage"
    "preventDefault" "stopPropagation" "observe" "observeAttributes" "observeError" "close"
    "setWindowOpacity" "playSound" "playSounds" "stopSounds" "requestMIDIAccess" "sendMIDI"
    "some" "pending" "failure" "empty" "after" "every"
    ; end generated
    ))

((call function: (identifier) @constructor)
  (#match? @constructor "^[A-Z]"))

; The first word of a line: a tag in a view…
((line . (identifier) @tag)
  (#any-of? @tag
    ; generated: tags
    "a" "article" "aside" "audio" "b" "box" "br" "button" "canonical" "canvas" "caption" "card"
    "circle" "clipPath" "code" "column" "container" "dd" "defs" "description" "details" "dialog"
    "div" "divider" "dl" "dt" "edited" "ellipse" "em" "feBlend" "feColorMatrix"
    "feComponentTransfer" "feComposite" "feConvolveMatrix" "feDiffuseLighting"
    "feDisplacementMap" "feDistantLight" "feDropShadow" "feFlood" "feFuncA" "feFuncB" "feFuncG"
    "feFuncR" "feGaussianBlur" "feMerge" "feMergeNode" "feMorphology" "feOffset" "fePointLight"
    "feSpecularLighting" "feSpotLight" "feTile" "feTurbulence" "filter" "flex" "footer"
    "foreignObject" "form" "g" "grid" "head" "header" "heading" "hr" "hstack" "i" "icon"
    "iframe" "image" "img" "input" "label" "li" "line" "linearGradient" "link" "list" "main"
    "marker" "mask" "meta" "nav" "ol" "option" "p" "paragraph" "path" "pattern" "picture"
    "polygon" "polyline" "pre" "progress" "radialGradient" "rect" "robots" "row" "scroll"
    "section" "select" "small" "spacer" "span" "stack" "status" "stop" "strong" "subtitle"
    "summary" "svg" "symbol" "table" "tbody" "td" "text" "textarea" "tfoot" "th" "thead" "time"
    "title" "tr" "tspan" "ul" "use" "video" "view" "vstack"
    ; end generated
    ))

; …a native module's hyphenated tag…
((line . (identifier) @tag)
  (#match? @tag "^[a-z][A-Za-z0-9_]*-[A-Za-z]"))

; …or a keyword.
((line . (identifier) @keyword)
  (#any-of? @keyword
    "component" "shape" "style" "keyframes" "timeline" "fn" "routes" "use" "members" "state"
    "derive" "resource" "mutation" "action" "task" "sequence" "let" "send" "refresh" "if" "else"
    "for" "match" "case" "props" "view" "inject" "provide" "slot" "test" "font" "sound"
    "color-profile" "tab" "stack" "expect" "tap" "type" "clock" "request" "log" "reload"
    "children" "from" "to"))

; A field or prop, `name: type`, even when its name is a tag's or a keyword's.
(line . (identifier) @property . (delimiter) @punctuation.delimiter
  (#eq? @punctuation.delimiter ":"))
(call (identifier) @variable.parameter . (delimiter) @punctuation.delimiter
  (#eq? @punctuation.delimiter ":"))

; What a declaration names.
((line . (identifier) @_k . (identifier) @type)
  (#any-of? @_k "component" "shape" "style" "keyframes" "timeline" "members"))

((line . (identifier) @_k . (identifier) @function)
  (#any-of? @_k "action" "task" "sequence"))

((line . (identifier) @_k . (call function: (identifier) @function))
  (#any-of? @_k "fn" "action" "task" "sequence"))

((line . (identifier) @_k . (attribute name: (identifier) @variable))
  (#any-of? @_k "state" "derive" "resource" "let" "send"))

((line . (identifier) @_k . (identifier) @variable)
  (#any-of? @_k "mutation" "routes" "refresh"))

; A line that opens with `name =` is a statement writing that name, not an attribute.
(line . (attribute name: (identifier) @variable))
