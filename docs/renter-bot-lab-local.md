# Run the isolated Renter Bot Lab locally

The local Lab uses a local Convex database and the current checkout's Next.js draft API. It binds the page to loopback, seeds only three Lab account and pickup fixtures, and keeps renter-send authorization disabled. Prepared scenarios use the existing Lab scenario path. No renter conversations or reservations are copied.

From this project checkout, start it with an OpenRouter key supplied by the authorized local vault:

    ai-vault openrouter OPENROUTER_API_KEY=OPENROUTER_API_KEY -- pnpm run lab:local

Open http://127.0.0.1:3000/renter-bot-lab. The status panel reports the active local backend, exact source fingerprint, generator contract, model lane, and readiness. If the checkout changes, the local source fingerprint changes on the next status check.

The command refuses non-local Convex deployments, does not call a hosted deployment setup command, and does not enable Hygglo messaging. Stop it with Ctrl+C.
