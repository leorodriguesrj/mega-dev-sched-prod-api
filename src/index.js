// sched-prod API: the incidents the status page and the board read. Contract: contract/api.md.

const json = (body, status = 200) => Response.json(body, { status });

async function feed(env) {
  const res = await fetch(env.FEED_URL);
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const { incidents } = await res.json();
  return incidents;
}

function findIncident(incidents, id) {
  return incidents.find(i => i.id === id);
}

function filterIncidents(incidents, status) {
  if (!status) return incidents;
  return incidents.filter(i => i.status === status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/incidents') {
      const status = url.searchParams.get('status');
      let incidents = await feed(env);
      incidents = filterIncidents(incidents, status);
      return json({ incidents });
    }
    if (request.method === 'GET' && url.pathname.startsWith('/incidents/')) {
      const id = url.pathname.split('/')[2];
      const incidents = await feed(env);
      const incident = findIncident(incidents, id);
      if (incident) {
        return json({ incident });
      }
      return json({ error: 'not found' }, 404);
    }
    return json({ error: 'not found' }, 404);
  },
};
