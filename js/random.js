// 암호학적으로 안전한 난수 유틸리티.
// Math.random 대신 crypto.getRandomValues를 쓰고, 모듈로 편향을 막기 위해 rejection sampling을 사용한다.

const buf = new Uint32Array(1);

/** [0, max) 범위의 균등한 정수 */
export function randomInt(max) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError(`max must be a positive integer: ${max}`);
  const limit = Math.floor(0x100000000 / max) * max;
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= limit);
  return x % max;
}

/** Fisher–Yates 셔플 (원본은 건드리지 않음) */
export function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
