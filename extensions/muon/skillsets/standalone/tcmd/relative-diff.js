export function relativeDelta(previous, current) {
  const before = previous.split("\n");
  const after = current.split("\n");

  if (previous === current) return { text: "", aligned: true };
  if (!previous) return { text: current.trim(), aligned: true };

  let commonPrefix = 0;
  while (commonPrefix < before.length && commonPrefix < after.length && before[commonPrefix] === after[commonPrefix]) {
    commonPrefix++;
  }
  if (commonPrefix === before.length) {
    return { text: after.slice(commonPrefix).join("\n").trim(), aligned: true };
  }

  const maxOverlap = Math.min(before.length, after.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    let matches = true;
    for (let index = 0; index < overlap; index++) {
      if (before[before.length - overlap + index] !== after[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return { text: after.slice(overlap).join("\n").trim(), aligned: true };
    }
  }

  return { text: current.trim(), aligned: false };
}
