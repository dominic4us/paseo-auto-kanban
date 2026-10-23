/**
 * REQ-160: a settings row whose control is a switch keeps the switch on the right of its title, at the title's height,
 * on a phone as wide — never on a line of its own under the description. What hangs under the switch (a damaged-file
 * notice, the lab's status line) runs the full width under the description on a phone, and stays under the switch when wide.
 * REQ-161: wide too it runs the full width under the description (508 J1: beside the switch it squeezed the title to nothing).
 * On a phone the description is behind the ⓘ after the name: `help` is then the name with its ⓘ, and `short` the row's
 * short line under them (null where the row has none).
 */
export async function switchRow(p, row, toggle, under) {
  return await p.evaluate(({ row, toggle, under }) => {
    const q = id => document.querySelector(`[data-testid="${id}"]`), r = q(row), t = q(toggle), u = under ? q(under) : null;
    if (!r || !t) return null;
    const rect = e => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
    const title = rect(r.querySelector('[dir="auto"]')), glyph = q('info-glyph-' + row), help = q('help-' + row), short = q('short-' + row);
    const named = glyph ? { ...title, right: Math.max(title.right, rect(glyph).right) } : title;
    return { title: named, help: help ? rect(help) : named, short: short ? rect(short) : null, sw: rect(t), row: rect(r), under: u ? rect(u) : null };
  }, { row, toggle, under });
}

/**
 * The switch right of the whole title and description, at the row's right edge. On a phone its top is on the title's line;
 * wide, it stays as it was, centred on the text beside it (its top above the description's bottom).
 */
export const switchBeside = (g, mobile) => !!g && g.sw.left > g.title.left && g.sw.left >= Math.max(g.title.right, g.help.right) - .5
  && (mobile ? g.sw.top <= g.title.bottom : g.sw.top < g.help.bottom && g.sw.bottom > g.title.top)
  && g.sw.right <= g.row.right + 1 && g.sw.right >= g.row.right - 2;

/**
 * The extra line under the description (and the short line) and the switch, as wide as the row — on a phone as wide (REQ-161),
 * the title keeping its width.
 */
export const underPlaced = (g, _mobile) => !!g?.under && g.title.right - g.title.left > 0
  && g.under.top >= Math.max(g.help.bottom, g.short?.bottom ?? 0) - .5 && g.under.top >= g.sw.bottom - .5
  && g.under.left <= g.help.left + 1 && g.under.right >= g.sw.right - 1;
