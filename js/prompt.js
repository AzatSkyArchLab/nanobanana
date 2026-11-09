// Инструкция модели для правки по пометкам.
//
// Каркас проверен на живых запросах. Приказ «Edit image 1: change ONLY …»
// обязан стоять до запретов: без него модель получает только список того,
// что менять нельзя, и возвращает исходник нетронутым.
//
// Порядок картинок в запросе: 1 оригинал, 2 та же картинка с пометками,
// дальше референсы областей подряд в порядке палитры.

const clean = (text) => (text || '').trim().replace(/[.!;:,\s]*$/, '');
const upper = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function imageList(first, count) {
  if (count === 1) return `image ${first}`;
  if (count === 2) return `images ${first} and ${first + 1}`;
  return `images ${first} to ${first + count - 1}`;
}

/**
 * regions: [{ colour, text, refs }], где refs: число референсов области.
 * subject: 'picture' для картинки, 'sheet' для листа PDF, 'fragment' для
 * его фрагмента.
 */
export function buildEditPrompt({ regions, general = '', subject = 'picture' }) {
  const many = regions.length > 1;
  const noun = subject === 'picture' ? 'picture' : subject === 'sheet' ? 'drawing sheet' : 'fragment of a drawing sheet';
  const list = regions.map((r) => `${r.colour.en} (${r.colour.ru})`).join(', ');
  const totalRefs = regions.reduce((s, r) => s + r.refs, 0);

  let next = 3;
  const refLines = [];
  const orders = regions.map((r) => {
    const parts = [];
    const text = clean(r.text);
    if (text) parts.push(text);
    if (r.refs) {
      const images = imageList(next, r.refs);
      const fitted = "fitted to the region's size, perspective, lighting and style";
      refLines.push(`${upper(images)} ${r.refs === 1 ? 'is the reference' : 'are the references'} for the ${r.colour.en} region.`);
      // Без текста приказом становится сам референс.
      parts.push(text
        ? `use ${images} as the exact reference for what must appear there, ${fitted}`
        : `place exactly what ${images} ${r.refs === 1 ? 'shows' : 'show'} into it, ${fitted}`);
      next += r.refs;
    }
    return { colour: r.colour, order: parts.join('; ') };
  });

  const intro = totalRefs
    ? `You are given ${2 + totalRefs} images: two of the same ${noun} and ${totalRefs === 1 ? 'one reference' : `${totalRefs} references`}.`
    : `You are given two images of the same ${noun}.`;

  const scene = many
    ? `Image 2 is the same ${noun} with translucent overlays marking several regions, in these colours: ${list}.`
    : `Image 2 is the same ${noun} with a translucent ${list} overlay marking one region.`;

  const order = many
    ? `Edit image 1: change ONLY the regions covered by those overlays, applying each instruction to the region whose colour it names. ${orders.map((o) => `${upper(o.colour.en)} region: ${o.order}.`).join(' ')}`
    : `Edit image 1: change ONLY the region covered by the overlay: ${orders[0].order}.`;

  const extra = clean(general);

  return [
    intro,
    `Image 1 is the original ${noun}.`,
    scene,
    ...refLines,
    order,
    extra ? `${upper(extra)}.` : '',
    `Keep everything outside the marked ${many ? 'regions' : 'region'} exactly as in image 1: same composition, colors, lighting, textures and details.`,
    subject === 'picture' ? '' : 'Match the graphic style of the sheet: line weights, hatching, lettering and colours.',
    'The overlays are instruction markers, not content: they must not appear anywhere in the output.',
    totalRefs ? 'Take from the reference images only what goes into the regions, not their background or framing.' : '',
    `Output the edited ${noun} at the same framing and aspect ratio as image 1.`,
  ].filter(Boolean).join(' ');
}

/** Короткая подпись правки для истории: по-русски, как писал пользователь. */
export function describe(regions, general = '') {
  const parts = regions.map((r) => {
    const text = clean(r.text) || 'как на референсе';
    const refs = r.refs ? ` (реф. ${r.refs})` : '';
    return `${upper(r.colour.area)}: ${text}${refs}`;
  });
  const extra = clean(general);
  if (extra) parts.push(extra);
  return parts.join('. ') + '.';
}
