import { describe, expect, it } from 'vitest';
import { pictureFrameStyle } from '../src/components/picture-frame';

// The sizing rule is CSS, so these read the expression it writes: which
// terms each rule puts in `min()`. The sizes it gives are checked in a
// browser, where the CSS is laid out.
describe('pictureFrameStyle', () => {
  const size = { width: 900, height: 600 };

  it('keeps the shape as the aspect ratio', () => {
    expect(pictureFrameStyle(size, 'box').aspectRatio).toBe('1.5');
  });

  it('box: the picture’s own width and the height cap, no area term', () => {
    const { width } = pictureFrameStyle(size, 'box');
    expect(width).toBe('min(900px, var(--max-height-picture) * 1.5)');
  });

  it('area: the box terms and the area term', () => {
    const { width } = pictureFrameStyle(size, 'area');
    expect(width).toContain('900px, var(--max-height-picture) * 1.5, sqrt(');
    expect(width).toContain('var(--max-area-picture)');
  });

  it('a size with no shape: square, no wider than the column or the cap', () => {
    expect(pictureFrameStyle({ width: 0, height: 10 }, 'area')).toEqual({
      aspectRatio: '1',
      width: 'min(100%, var(--max-height-picture))',
    });
  });
});
