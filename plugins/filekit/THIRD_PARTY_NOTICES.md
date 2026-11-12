# Third-party notices

## DeepSeek Harness tool-definition helpers

`lib/define.js` implements a faithful port of the DeepSeek Harness tool-definition compiler and schema validator. `test/contract.test.mjs` also contains a port of the host authoring-form compiler and schema checker. These portions are attributed to DeepSeek and distributed under the MIT License:

> Copyright (c) 2026 DeepSeek

The complete copyright, permission, and warranty notice is reproduced in [licenses/deepseek-dsh-tools-MIT.txt](licenses/deepseek-dsh-tools-MIT.txt).

Upstream: <https://github.com/deepseek-ai/deepseek-harness>, package `@deepseek-ai/dsh-tools`, source directory `packages/core/tools`. The notice was verified against the locally installed package version `0.2.2-rc.1`; the exact historical revision used for the original port is not recorded. Local changes include a dependency-free standalone implementation and integration with the plugin's tool factory. The attribution applies to the ported portions, not all plugin code or every dependency of the host.

## Fixture provenance

The released DOCX and XLSX fixtures are generated from locally authored XML and a deterministic ZIP writer in `test/make-office-fixtures.mjs`, using only Node.js built-ins. Their package parts contain no python-docx default document, openpyxl theme, third-party thumbnail, or personal document properties. The small custom date-format styles in `dates.xlsx` are authored in that generator. Test text, cells, and serial date values are synthetic examples.

`sample.pdf` is reproduced by `test/make-pdf-fixture.mjs`, a local Node.js generator using `node:zlib`. It refers to the standard PDF Helvetica font name and embeds no font program. `sample.csv` contains synthetic parser examples.

Earlier workspace fixtures were created with python-docx/openpyxl and retained template parts. Those binary fixtures have been replaced in this release; the libraries and their templates are not included.

## Other provenance notes

The CSV, ZIP, DOCX, XLSX, and PDF parsers use Node.js built-ins and local modules. Review found no other explicit third-party code attribution in those parser files. This is a statement of the recorded evidence, not a guarantee of an exhaustive historical provenance chain. PDF CP1252/MacRoman encoding values and spreadsheet date-format identifiers describe standard format mappings; their original collection source is not recorded.

The project was informed by a review of `T-Auto/dsh-ops`; an idea reference alone does not establish a copied implementation. This plugin does not include the separately attributed dsh-ops compact renderer or structured outcome modules used by ops-lite, nor dsh-ops bundled runtimes. No dsh-ops composite distribution license is applied here on that basis.

The icon is a simple document outline with no linked or embedded image asset. Its original creation record has not been independently verified.
