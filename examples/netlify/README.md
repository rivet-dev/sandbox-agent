# Netlify Sandbox Agent Example

This example shows how to deploy sandbox-agent to Netlify Functions.

## Prerequisites

- Netlify account
- Netlify CLI installed: `npm install -g netlify-cli`
- API keys: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Login to Netlify:**
   ```bash
   netlify login
   ```

3. **Set environment variables:**
   ```bash
   # Via Netlify CLI
   netlify env:set ANTHROPIC_API_KEY "your-api-key"
   # OR
   netlify env:set OPENAI_API_KEY "your-api-key"
   ```

   Or set them in the Netlify web dashboard under Site Settings > Environment Variables.

4. **Deploy:**
   ```bash
   # Deploy to preview
   npm run deploy
   
   # Deploy to production
   npm run deploy:prod
   ```

## Usage

After deployment, you'll get a Netlify URL (e.g., `https://your-site.netlify.app`).

### Connect from TypeScript

```typescript
import { setupNetlifySandboxAgent } from "./src/netlify.js";

const { baseUrl, cleanup } = await setupNetlifySandboxAgent("https://your-site.netlify.app");

// Use the sandbox agent...
const client = await SandboxAgent.connect({ baseUrl });

await cleanup(); // (no-op for Netlify)
```

### Run the example

```bash
npm start https://your-site.netlify.app
```

## Local Development

Test locally with Netlify Dev:

```bash
# Start local development server
npm run dev
```

This will start the Netlify Dev server at `http://localhost:8888` and proxy function calls.

## Important Notes

- **Cold starts:** First request may take 1-2 minutes as the function installs and starts sandbox-agent
- **Timeouts:** Netlify Functions have a 10-second timeout for synchronous responses and 15 minutes for background functions
- **State:** Functions are stateless - sessions don't persist between invocations
- **Resource limits:** Functions have limited CPU and memory compared to dedicated servers

## Troubleshooting

1. **Function timeouts:** Increase timeout settings in `netlify.toml` if possible
2. **Cold starts:** Consider using Netlify's scheduled functions to keep the deployment warm
3. **Installation errors:** Check function logs in Netlify dashboard
4. **API key errors:** Verify environment variables are set correctly

## Configuration

See `netlify.toml` for deployment configuration:

- **Functions directory:** `netlify/functions`
- **Build command:** `npm run build`  
- **Environment:** Node.js 18
- **Redirects:** All traffic routed to the sandbox-agent function

## Security

- API keys are stored as Netlify environment variables
- Functions run in isolated environments
- All traffic is over HTTPS by default