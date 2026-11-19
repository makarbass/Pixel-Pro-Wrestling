import { PIXEL_GLYPHS } from './pixel-glyphs.mjs';

export function drawPixelText(ctx, value, center, baseline, size, color = '#fff9ee') {
  const glyphs = [...value.toUpperCase()].map((letter) => PIXEL_GLYPHS[letter] ?? PIXEL_GLYPHS['?']);
  const width = glyphs.reduce((sum, glyph) => sum + glyph[0].length + 1, -1) * size;
  for (const [offset, ink] of [[1, '#1a1821'], [0, color]]) {
    ctx.fillStyle = ink;
    let x = Math.round(center - width / 2) + offset;
    for (const glyph of glyphs) {
      const y = baseline - glyph.length * size + offset;
      for (const [row, pixels] of glyph.entries()) {
        for (const [col, pixel] of [...pixels].entries()) {
          if (pixel === '1') ctx.fillRect(x + col * size, y + row * size, size, size);
        }
      }
      x += (glyph[0].length + 1) * size;
    }
  }
}
