# Locale files in this fork

This fork does **not** use Crowdin (the upstream `crowdin.yml` is kept only to ease merges; no sync runs).
Nothing fills the other language files automatically, so when you add, change or remove a key:

- edit `ja-JP.yml` (the source the type generator `packages/i18n/build.ts` reads), `ko-KR.yml` and `en-US.yml` together, in the same commit
- edit the other locale files only when you want to; a missing key falls back to `ja-JP.yml` at runtime

`pnpm --filter i18n verify` checks that the parameters (`{name}` etc.) of every translated string match `ja-JP.yml`.

Please see [Contribution guide](../CONTRIBUTING.md) for more information.
