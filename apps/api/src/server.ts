import { serve } from '@hono/node-server'
import { createApp } from './app.js'

const port = Number(process.env.PORT ?? 8080)

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`goodgrades-api listening on http://localhost:${info.port}`)
})
