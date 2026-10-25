# pokelair-data

Daily Pokémon Champions (Reg M-C, VGC doubles) tournament data for PokéLair.

A scheduled GitHub Action runs `update.mjs` each morning. It pulls new tournaments from the public Limitless API (under its 50-requests-per-5-minutes limit), keeps every standing in `data/`, and rebuilds `out/limitless.json`:

- `adj`: each Pokémon's own share of team wins, from one model over every team so partners don't get credit
- `results`: Pokémon win rates, pairs seen on 25+ teams, cores on 40+ teams, and exact winning team lists

The first run is started by hand (Actions → Update Limitless data → Run workflow) and downloads the full history, which takes about 40 minutes.
