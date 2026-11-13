# Predictir

**Market research and paper trading**

Compare live exchange prices with supported independent forecasts, inspect the evidence, and practise with a paper portfolio.

[Request preview access](https://predictir.dev/access)

Request access to the main preview or open a private invitation link you already have. Predictir accounts belong to this app only.

## What you can do

- Explore eight market categories with live quotes, order-book depth and source timestamps.
- Compare YES and NO costs, model estimates, uncertainty and simulated outcomes.
- Buy and close paper positions against observed depth, then track cash, fees and P/L.
- Review supported HOLD/SELL decisions and compare alternative trades.
- Use **Ask why** for an explanation tied to the selected contract, evidence and panel.

Independent forecasts cover selected sports, economic, travel, weather and crypto series. Other contracts show market data and clearly marked scenarios. Research checks measure historical performance; they do not establish a profitable trading advantage. News affects numerical estimates only through supported, verified inputs. Reddit and X retrieval are disabled.

## Project map

| Folder | Purpose |
| --- | --- |
| [`web/`](web/) | Shared React and TypeScript app, research services and tests |
| [`azure/`](azure/) | Azure deployment configuration and maintenance workbench |
| [`cloudflare/`](cloudflare/) | DNS, HTTPS and private-access operating policy |
| [`components/`](components/) | Go depth replay, Java scoring and Ruby/MongoDB research receipts |
| [`connector/`](connector/) | Separate Python public-data adapter |

The main deployment uses Vercel, Railway and Supabase PostgreSQL. The Azure edition uses Container Apps, a private API and PostgreSQL, Key Vault and Azure Monitor. Both use the same app source.

## Run locally

Use Node.js 26.12.1:

```sh
cd web
npm ci
npm run dev -- --port 8768
```

Open [localhost:8768](http://localhost:8768). [Setup](web/docs/DEPLOYMENT.md) covers backend configuration. Secrets stay in private environment settings.

```sh
npm test
npm run typecheck
npm run build
```

[Research methods](web/docs/quant-research.md) · [Security](docs/SECURITY.md)

Paper portfolios are simulations. Browser-local positions remain on that device and origin; export them before clearing site data. Automatic position reviews run while the workspace is open.
