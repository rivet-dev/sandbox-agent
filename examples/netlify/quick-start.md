# Netlify Quick Start

Get your sandbox-agent running on Netlify in under 5 minutes!

## 🚀 One-Command Deploy

```bash
git clone https://github.com/rivet-dev/sandbox-agent
cd sandbox-agent/examples/netlify
./deploy.sh
```

That's it! The script will:
1. ✅ Check prerequisites 
2. ✅ Install dependencies
3. ✅ Set up API keys
4. ✅ Deploy to Netlify
5. ✅ Give you a working URL

## 🧪 Test Your Deployment

```bash
npm run test:integration https://your-site.netlify.app
```

## 📋 What You Need

- Netlify account (free)
- API key: [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)
- 5 minutes ⏱️

## 🔧 Manual Setup (If Preferred)

1. **Install Netlify CLI:**
   ```bash
   npm install -g netlify-cli
   netlify login
   ```

2. **Set API key:**
   ```bash
   netlify env:set ANTHROPIC_API_KEY "your-key"
   ```

3. **Deploy:**
   ```bash
   netlify deploy --prod
   ```

## 📖 Need More Help?

- **Full Guide:** [DEPLOYMENT-GUIDE.md](./DEPLOYMENT-GUIDE.md)
- **Documentation:** [netlify.mdx](../../docs/deploy/netlify.mdx)
- **Examples:** [src/netlify.ts](./src/netlify.ts)