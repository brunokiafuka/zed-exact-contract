; The outline: declarations and a component's members, in file order.

((line . (identifier) @context . (identifier) @name) @item
  (#any-of? @context "component" "shape" "style" "keyframes" "timeline" "routes" "members"))

((line . (identifier) @context . (identifier) @name) @item
  (#any-of? @context "action" "task" "sequence" "mutation"))

((line . (identifier) @context . (call function: (identifier) @name)) @item
  (#any-of? @context "fn" "action" "task" "sequence"))

((line . (identifier) @context . (attribute name: (identifier) @name)) @item
  (#any-of? @context "state" "derive" "resource"))

((line . (identifier) @context . (string) @name) @item
  (#any-of? @context "test" "members"))
