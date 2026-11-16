# Licensing

Luna Bot is free software under the [GNU Affero General Public License
v3.0](LICENSE). Anyone may run, study, modify and redistribute it; if you
distribute it or run a modified version as a network service, you must offer
your source under the same license.

## Where the code comes from

- New code and this fork's modifications: AGPL-3.0-only, copyright liguan-89
  and Luna Bot contributors.
- Code inherited from [OpenMausBot](https://github.com/milind-soni/OpenMausBot)
  remains Apache 2.0: see [LICENSE.apache](LICENSE.apache) and [NOTICE](NOTICE)
  for the upstream copyright, relicensing note and third-party notices. The
  Apache license text is kept in `LICENSE.apache` for those portions.
- Bundled third-party software keeps its own licenses; the SBOM and source
  locations are in [NOTICE](NOTICE) and [`third_party/`](third_party/).

## The upstream enterprise layer

Upstream OpenMausBot ships a source-available `enterprise/` directory behind a
license key. This fork does not include it: the server builds and boots without
it and reports `{"edition":"oss"}`, and hosted sign-in is provided by this
fork's own [Luna Bot Cloud](https://cloud.dexai.vip) deployment instead. The
"open-source edition builds without enterprise/" CI job keeps proving that.

## Contributions

- Contribute under AGPL-3.0. No DCO sign-off or CLA is required. Submit only
  code you wrote or have the right to contribute.
- The open-core boundary and this file are covered by
  [`CODEOWNERS`](.github/CODEOWNERS): a maintainer reviews changes there.

## Trademarks

The OpenMausBot and MausBot names and the mascot are trademarks of Supamaus
Software Private Limited; neither the Apache License nor the AGPL grants
trademark rights (section 6 / section 7). Luna Bot is this fork's own name.
