// Talks to the Go server over HTTP.
export async function load(key: string): Promise<string> {
  const res = await fetch(`/api/${key}`)
  return res.text()
}
