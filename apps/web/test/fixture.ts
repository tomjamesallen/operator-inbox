// A JSON response, as the server sends one: the JSON `operator-inbox serve`
// encodes, so a test exercises the client's real decode through the shared
// contract.
export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
