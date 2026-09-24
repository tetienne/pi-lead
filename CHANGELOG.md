# Changelog

## [0.6.0](https://github.com/tetienne/pi-lead/compare/v0.5.0...v0.6.0) (2026-09-24)


### ⚠ BREAKING CHANGES

* `steerUnverifiedDone` is removed, along with the shell-history heuristic behind it (`isTestCommand`, `lastTest`, the send-back of an unverified `done`): guessing whether the model tested from its commands was unsound (`npm test || true`, unknown runners, stale runs).
* trim the Jev display and drop jev.display ([#26](https://github.com/tetienne/pi-lead/issues/26))

### Features

* verify worker results with a host-run project command ([#25](https://github.com/tetienne/pi-lead/issues/25)) ([6ff99d0](https://github.com/tetienne/pi-lead/commit/6ff99d0a51b82a8229e3f7dd01d31fbc6f20a259))


### Bug Fixes

* make the sensitive-path check a quieter review hint ([#24](https://github.com/tetienne/pi-lead/issues/24)) ([82238a8](https://github.com/tetienne/pi-lead/commit/82238a848e889490d168ac7399a61608dc4323d6))
* sanitise Jev transcript lines that fit the terminal ([#21](https://github.com/tetienne/pi-lead/issues/21)) ([645db89](https://github.com/tetienne/pi-lead/commit/645db8955b4568e908b3bdc741cf816d988e1f62))


### Code Refactoring

* trim the Jev display and drop jev.display ([#26](https://github.com/tetienne/pi-lead/issues/26)) ([d64643a](https://github.com/tetienne/pi-lead/commit/d64643ac01d77d5d756cbf7c7859f3a469cf2eb0))

## [0.5.0](https://github.com/tetienne/pi-lead/compare/v0.4.0...v0.5.0) (2026-09-23)


### Features

* send an unverified done back to the worker once ([#16](https://github.com/tetienne/pi-lead/issues/16)) ([ff638d1](https://github.com/tetienne/pi-lead/commit/ff638d105981b4add42718f65cf39280f707eff2))
* show Jev decisions and usage in the terminal ([#19](https://github.com/tetienne/pi-lead/issues/19)) ([e3d557f](https://github.com/tetienne/pi-lead/commit/e3d557f1fb9cdaac51f65be4538b47855776b755))
* steer a worker that keeps repeating a failing approach ([#17](https://github.com/tetienne/pi-lead/issues/17)) ([7b5ed44](https://github.com/tetienne/pi-lead/commit/7b5ed44f524145b122462dbebdedf98c9bc515f4))

## [0.4.0](https://github.com/tetienne/pi-lead/compare/v0.3.2...v0.4.0) (2026-09-23)


### Features

* judge worker verdicts on commits, changed files and the last test run ([#14](https://github.com/tetienne/pi-lead/issues/14)) ([2d25aba](https://github.com/tetienne/pi-lead/commit/2d25abad310c48bcc3640f21fe5cb1a6f0f70266))
* tell the user when Jev is failing or over budget ([#12](https://github.com/tetienne/pi-lead/issues/12)) ([255b11b](https://github.com/tetienne/pi-lead/commit/255b11bc8d5c7094c3075901a9ce610968d7a7c6))
* warn when a worker branch touches host-executed files ([#13](https://github.com/tetienne/pi-lead/issues/13)) ([d53c0a3](https://github.com/tetienne/pi-lead/commit/d53c0a35df6dc5a104793c9ebe3ba048487e01c8))


### Performance Improvements

* ask Jev readiness and difficulty in one call ([#11](https://github.com/tetienne/pi-lead/issues/11)) ([b0e7a54](https://github.com/tetienne/pi-lead/commit/b0e7a542d8ea9c9d8d9e9eec550f653ca4bb7ed6))

## [0.3.2](https://github.com/tetienne/pi-lead/compare/v0.3.1...v0.3.2) (2026-09-23)


### Bug Fixes

* mount every loaded skill in the worker VM ([#9](https://github.com/tetienne/pi-lead/issues/9)) ([3380e75](https://github.com/tetienne/pi-lead/commit/3380e75958898802276b81078682f9d744ae434f))

## [0.3.1](https://github.com/tetienne/pi-lead/compare/v0.3.0...v0.3.1) (2026-09-23)


### Bug Fixes

* make project mise toolchains usable in workers ([#7](https://github.com/tetienne/pi-lead/issues/7)) ([f490db6](https://github.com/tetienne/pi-lead/commit/f490db696b08acd1af5d9420e9b9d1ac05a311de))

## [0.3.0](https://github.com/tetienne/pi-lead/compare/v0.2.0...v0.3.0) (2026-09-23)


### Features

* download the worker image from the release instead of building it ([#5](https://github.com/tetienne/pi-lead/issues/5)) ([09387c3](https://github.com/tetienne/pi-lead/commit/09387c37a50dec56382ee75789a5329c03055d31))

## [0.2.0](https://github.com/tetienne/pi-lead/compare/v0.1.2...v0.2.0) (2026-09-23)


### Continuous Integration

* release with Release Please and check every push ([#3](https://github.com/tetienne/pi-lead/issues/3)) ([caeecbd](https://github.com/tetienne/pi-lead/commit/caeecbdac7047f84b2df1db6505437ea3b5b3e0e))
