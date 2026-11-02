// Trigglow Dynamic Delay's live badge, drawn exactly like the plugin's QPainter version (overlay-badge.cpp
// RenderDelayBadge): a 200x72 design at 2.5x (500x180 PNG): the 200x58 ink plate with its frame and cyan→magenta
// brand rule, the Dynamic Delay mark, "DELAY" in cyan and the seconds in mist (Archivo, shrunk to fit), and under the
// plate, on transparent pixels, the "By Trigglow" signature in Geist Mono with its soft outline.
const W = 200;
const PLATE_H = 58;
const H = 72;
const SCALE = 2.5;
const INK = '15,16,22';
const MIST = '242,241,238';
const CYAN = '#00d2ff';
const MAGENTA = '#c44dff';

const mark = new Image();
mark.src = 'dynamic-delay-mark.png';
const ready = Promise.all([mark.decode().catch(() => null), document.fonts.load("600 18px 'Archivo'"), document.fonts.load("700 26px 'Archivo'"), document.fonts.load("500 11px 'Geist Mono'")]);

/** One badge as a PNG data URL. `label` "Delay", `value` "30 s", `signature` "By Trigglow". */
window.drawBadge = async (label, value, signature) => {
  await ready;
  const cv = document.createElement('canvas');
  cv.width = Math.round(W * SCALE);
  cv.height = Math.round(H * SCALE);
  const p = cv.getContext('2d');
  p.scale(SCALE, SCALE);
  // Outer hairline, the plate, its inner frame, the brand rule.
  p.strokeStyle = 'rgba(0,0,0,0.55)';
  p.lineWidth = 1;
  p.strokeRect(0.5, 0.5, W - 1, PLATE_H - 1);
  p.fillStyle = `rgba(${INK},0.92)`;
  p.fillRect(1, 1, W - 2, PLATE_H - 2);
  p.strokeStyle = `rgba(${MIST},0.18)`;
  p.strokeRect(1.5, 1.5, W - 3, PLATE_H - 3);
  const brand = p.createLinearGradient(1, 0, W - 1, 0);
  brand.addColorStop(0, CYAN);
  brand.addColorStop(1, MAGENTA);
  p.fillStyle = brand;
  p.fillRect(1, 1, W - 2, 3);
  // The mark and the divider.
  if (mark.naturalWidth) p.drawImage(mark, 10, 14, 32, 32);
  p.strokeStyle = `rgba(${MIST},0.16)`;
  p.beginPath();
  p.moveTo(50.5, 16);
  p.lineTo(50.5, 46);
  p.stroke();
  // Label and value on one baseline, shrunk 5 % at a time until they fit (like the plugin).
  const labelText = label.toUpperCase();
  const valueText = value.replace(/\s/g, ' ');
  const LEFT = 60;
  const RIGHT = 190;
  const BASELINE = 39.5;
  const GAP = 7;
  let factor = 1;
  let labelWidth = 0;
  for (let attempt = 0; attempt < 12; attempt++) {
    p.font = `600 ${18 * factor}px 'Archivo'`;
    p.letterSpacing = `${1 * factor}px`;
    labelWidth = p.measureText(labelText).width;
    p.font = `700 ${26 * factor}px 'Archivo'`;
    p.letterSpacing = '0px';
    p.fontVariantNumeric = 'tabular-nums';
    const valueWidth = p.measureText(valueText).width;
    if (LEFT + labelWidth + GAP + valueWidth <= RIGHT) break;
    factor *= 0.95;
  }
  p.textBaseline = 'alphabetic';
  p.font = `600 ${18 * factor}px 'Archivo'`;
  p.letterSpacing = `${1 * factor}px`;
  p.fillStyle = CYAN;
  p.fillText(labelText, LEFT, BASELINE);
  p.font = `700 ${26 * factor}px 'Archivo'`;
  p.letterSpacing = '0px';
  p.fillStyle = `rgb(${MIST})`;
  p.fillText(valueText, LEFT + labelWidth + GAP, BASELINE);
  // The signature under the plate: stroked twice in soft black, filled in mist.
  const sig = signature.trim();
  if (sig) {
    let size = 11;
    let width = 0;
    for (let attempt = 0; attempt < 12; attempt++) {
      p.font = `500 ${size}px 'Geist Mono'`;
      p.letterSpacing = `${0.4 * (size / 11)}px`;
      width = p.measureText(sig).width;
      if (11 + width <= W - 2) break;
      size *= 0.95;
    }
    const cap = p.measureText('H').actualBoundingBoxAscent;
    const baseline = PLATE_H + 2.5 + cap;
    p.lineJoin = 'round';
    p.lineCap = 'round';
    p.strokeStyle = 'rgba(0,0,0,0.14)';
    p.lineWidth = 2.4;
    p.strokeText(sig, 11, baseline);
    p.strokeStyle = 'rgba(0,0,0,0.38)';
    p.lineWidth = 1.3;
    p.strokeText(sig, 11, baseline);
    p.fillStyle = `rgba(${MIST},0.75)`;
    p.fillText(sig, 11, baseline);
  }
  return cv.toDataURL('image/png');
};
