export function route(evt, table) { const h = table[evt.type]; return h ? h(evt) : null }
