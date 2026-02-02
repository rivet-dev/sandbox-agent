# Cloudflare Sandbox Agent Example

Deploy sandbox-agent inside a Cloudflare Sandbox.

## Prerequisites

- Cloudflare account with Workers Paid plan
- Docker running locally for `wrangler dev`
- `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` for the coding agents

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create `.dev.vars` with your API keys:

```bash
echo "ANTHROPIC_API_KEY=your-api-key" > .dev.vars
```

## Development

Start the development server:

```bash
pnpm run dev
```

Test the endpoint:

```bash
curl http://localhost:8787
```

## Deploy

```bash
pnpm run deploy
```

Note: Production preview URLs require a custom domain with wildcard DNS routing.
See [Cloudflare Production Deployment](https://developers.cloudflare.com/sandbox/guides/production-deployment/) for details.
