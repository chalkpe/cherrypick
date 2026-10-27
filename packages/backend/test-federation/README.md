## test-federation
Test federation between two CherryPick servers: `a.test` and `b.test`.

Before testing, you need to build the entire project, and change working directory to here:
```sh
pnpm build
cd packages/backend/test-federation
```

`NODE_VERSION` selects the Node.js image the servers and the tester run on.
Use the same major version as the repository's `.node-version` (currently 26), which is also the version `pnpm build` should run on.
CI passes the full version from that file (`NODE_VERSION=$(cat ../../../.node-version)` from here).

First, you need to start servers by executing following commands:
```sh
bash ./setup.sh
NODE_VERSION=26 docker compose up --scale tester=0
```

Then you can run all tests by a following command:
```sh
NODE_VERSION=26 docker compose run --no-deps --rm tester
```

For testing a specific file, run a following command.
The path is relative to `packages/backend`, where `test:fed` runs:
```sh
NODE_VERSION=26 docker compose run --no-deps --rm tester -- pnpm -F backend test:fed test-federation/test/user.test.ts
```
