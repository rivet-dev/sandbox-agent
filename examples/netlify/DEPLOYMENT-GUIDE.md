# Netlify Deployment Guide

This guide provides step-by-step instructions for deploying sandbox-agent to Netlify Functions.

## Prerequisites

1. **Netlify Account**: Sign up at [netlify.com](https://netlify.com)
2. **API Keys**: Get either:
   - [Anthropic API Key](https://console.anthropic.com/) (recommended)
   - [OpenAI API Key](https://platform.openai.com/api-keys)
3. **Node.js**: Version 18 or higher
4. **Git**: For version control (optional but recommended)

## Quick Start (Automated)

Use the automated deployment script:

```bash
# Make sure you're in the netlify example directory
cd examples/netlify

# Run the automated deployment script
./deploy.sh
```

The script will guide you through the entire process.

## Manual Deployment

### Step 1: Setup

```bash
# Install Netlify CLI globally
npm install -g netlify-cli

# Install project dependencies
npm install

# Login to Netlify
netlify login
```

### Step 2: Environment Variables

Set your API keys. Choose one method:

**Method A: Via Netlify CLI**
```bash
netlify env:set ANTHROPIC_API_KEY "your-api-key-here"
# OR
netlify env:set OPENAI_API_KEY "your-api-key-here"
```

**Method B: Via Netlify Dashboard**
1. Go to your site in the Netlify dashboard
2. Navigate to Site Settings > Environment Variables
3. Add `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`

**Method C: Via Local Environment (Development Only)**
```bash
cp .env.example .env
# Edit .env with your API keys
```

### Step 3: Deploy

```bash
# Deploy to production
netlify deploy --prod

# Or deploy to a preview first
netlify deploy
```

### Step 4: Test

```bash
# Test the deployment
npm run test:integration https://your-site.netlify.app
```

## Configuration Options

### netlify.toml

The `netlify.toml` file controls your deployment:

```toml
[build]
  functions = "netlify/functions"  # Where your functions are located
  
[functions]
  directory = "netlify/functions"
  node_bundler = "esbuild"         # Fast bundling

[[redirects]]
  from = "/*"
  to = "/.netlify/functions/sandbox-agent"
  status = 200                     # Route all traffic to main function
```

### Function Configuration

Netlify Functions have several limitations to be aware of:

- **Timeout**: 10 seconds for synchronous responses, 15 minutes for background
- **Memory**: 1008 MB maximum
- **Payload**: 6 MB for synchronous, 2 MB for background functions
- **Cold starts**: Functions may take time to initialize

## Performance Optimization

### Reducing Cold Starts

1. **Scheduled Functions**: Keep your deployment warm
   ```javascript
   // netlify/functions/keep-warm.js
   exports.handler = async () => {
     // Ping your main function every 5 minutes
     await fetch(process.env.URL + '/.netlify/functions/sandbox-agent/health');
     return { statusCode: 200 };
   };
   ```

2. **Pre-built Binaries**: Cache sandbox-agent installation
3. **Optimized Dependencies**: Only include necessary packages

### Monitoring

1. **Function Logs**: Monitor via Netlify dashboard
2. **Health Endpoint**: Use `/health` for uptime monitoring
3. **Analytics**: Track function invocations and errors

## Troubleshooting

### Common Issues

**1. Function Timeout**
```
Error: Function timed out
```
- **Cause**: Installation taking too long
- **Solution**: Pre-build sandbox-agent, optimize cold start logic

**2. Missing API Keys**
```
Error: ANTHROPIC_API_KEY required
```
- **Cause**: Environment variables not set
- **Solution**: Set API keys via Netlify CLI or dashboard

**3. Installation Failures**
```
Error: Installation failed with code 1
```
- **Cause**: Network issues, platform compatibility
- **Solution**: Check function logs, verify Alpine Linux compatibility

**4. Memory Errors**
```
Error: Cannot allocate memory
```
- **Cause**: Function memory limits exceeded
- **Solution**: Optimize memory usage, consider upgrading plan

### Debugging

**View Function Logs**
```bash
netlify logs
netlify functions:list
```

**Test Locally**
```bash
netlify dev
# Your function will be available at http://localhost:8888
```

**Check Environment Variables**
```bash
netlify env:list
```

### Performance Issues

**Cold Start Taking Too Long**
- Consider using a dedicated server (E2B, Daytona) for production
- Implement keep-warm functions
- Pre-build and cache dependencies

**Function Timing Out**
- Increase function timeout if possible
- Optimize installation process
- Use background functions for long-running tasks

## Production Considerations

### When to Use Netlify

✅ **Good for:**
- Demos and prototypes
- Serverless architectures
- Infrequent usage patterns
- Simple integrations

❌ **Not ideal for:**
- High-frequency production workloads
- Real-time applications
- Long-running sessions
- Performance-critical applications

### Alternatives for Production

For production workloads, consider:
- [E2B](/deploy/e2b) - Dedicated sandbox environments
- [Daytona](/deploy/daytona) - Cloud development workspaces
- [Docker](/deploy/docker) - Containerized deployments

## Security Best Practices

1. **API Keys**: Store in Netlify environment variables, never in code
2. **HTTPS**: All Netlify deployments use HTTPS by default
3. **Function Isolation**: Each function runs in an isolated environment
4. **Access Control**: Use Netlify's access control features if needed

## Monitoring and Maintenance

### Set Up Monitoring

1. **Uptime Monitoring**: Use the `/health` endpoint
2. **Error Tracking**: Monitor function logs for errors
3. **Performance Metrics**: Track cold start times and response latencies

### Regular Maintenance

1. **Update Dependencies**: Keep packages up to date
2. **Monitor Logs**: Check for errors and performance issues
3. **Test Regularly**: Run integration tests to ensure functionality
4. **Review Costs**: Monitor Netlify function usage and costs

## Cost Estimation

Netlify Functions pricing (as of 2024):
- **Free Tier**: 125,000 requests/month, 100 hours runtime
- **Pro Plan**: $19/month, 2M requests, 1000 hours runtime
- **Overage**: $25 per million requests

Typical sandbox-agent usage:
- **Cold start**: ~30-60 seconds runtime
- **API requests**: ~1-5 seconds each
- **Session**: Variable based on activity

Estimate your costs based on expected usage patterns.

## Getting Help

1. **Documentation**: Review the main [Netlify docs](/deploy/netlify)
2. **Function Logs**: Check Netlify dashboard for detailed error logs
3. **Integration Test**: Run `npm run test:integration <url>` to verify deployment
4. **Community**: Ask questions in the Rivet Discord or GitHub issues

## Next Steps

After successful deployment:

1. **Test Thoroughly**: Run integration tests with your specific use cases
2. **Monitor Performance**: Set up monitoring for production use
3. **Optimize**: Implement performance optimizations based on your usage
4. **Scale**: Consider alternatives if you outgrow Netlify Functions

For high-volume production use, consider migrating to E2B or Daytona for better performance and reliability.