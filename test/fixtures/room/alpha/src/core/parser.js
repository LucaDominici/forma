// Touched by the commit citing #99, which is a pull request number and not an issue in the
// snapshot — the case that used to inflate the landing chart.
export function parse(text) {
  return String(text).split(',').map((part) => part.trim())
}
