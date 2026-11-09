/**
 * Tree-sitter grammar for Exact Contract (.contract).
 *
 * Deliberately tolerant and line-oriented: Contract changes daily, so this
 * grammar models the lexical shape of a line (strings, templates, calls,
 * attributes, groups) and leaves keywords, tags and declarations to the
 * highlight queries. The compiler stays the authority on what is valid.
 */
module.exports = grammar({
  name: 'contract',

  extras: _ => [/[ \t\r]+/],

  rules: {
    source_file: $ => repeat(choice($.line, $._newline)),

    _newline: _ => /\n/,

    line: $ => prec.right(choice(
      $.comment,
      seq(repeat1($._item), optional($.comment)),
    )),

    comment: _ => token(seq('//', /[^\n]*/)),

    _item: $ => choice(
      $.attribute,
      $.call,
      $.member,
      $.identifier,
      $.string,
      $.template,
      $.number,
      $.group,
      $.list,
      $.block,
      $.operator,
      $.delimiter,
    ),

    // `gap=8`, `press=save`, and also `count = count + 1`: a name and its `=`.
    attribute: $ => prec(2, seq(field('name', $.identifier), '=')),

    // `save(id)`: a name with `(` touching it. `text (a ? b : c)` is not a call.
    call: $ => seq(
      field('function', $.identifier),
      token.immediate(prec(1, '(')),
      repeat($._inner),
      ')',
    ),

    member: $ => seq('.', field('property', choice($.identifier, $.number))),

    // Brackets may span lines: `state tabs = [` … `]`, a call's arguments.
    _inner: $ => choice($._item, $._newline, $.comment),

    group: $ => seq('(', repeat($._inner), ')'),
    list: $ => seq('[', repeat($._inner), ']'),
    block: $ => seq('{', repeat($._inner), '}'),

    identifier: _ => /-{0,2}[A-Za-z_]([A-Za-z0-9_]|-[A-Za-z])*/,

    number: _ => /\d+(\.\d+)?/,

    string: $ => seq(
      '"',
      repeat(choice($.escape, token.immediate(prec(1, /[^"\\\n]+/)))),
      token.immediate('"'),
    ),

    template: $ => seq(
      '`',
      repeat(choice(
        $.escape,
        $.interpolation,
        token.immediate(prec(1, /[^`\\$\n]+/)),
        token.immediate('$'),
      )),
      token.immediate('`'),
    ),

    interpolation: $ => seq(token.immediate('${'), repeat($._item), '}'),

    escape: _ => token.immediate(seq('\\', choice(
      /[nt"\\`$]/,
      /u\{[0-9A-Fa-f]{1,6}\}/,
      /u[0-9A-Fa-f]{4}/,
      /./,
    ))),

    operator: _ => choice(
      '==', '!=', '<=', '>=', '=>', '&&', '||', '??',
      '=', '+', '-', '*', '/', '%', '!', '?', '<', '>', '|', '&', '@', '#', '^', '~',
    ),

    delimiter: _ => choice(':', ',', ';'),
  },
});
