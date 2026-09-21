# Third-party notices

The dashboard is compiled locally and does not load application code, fonts, images, or other
media from a CDN. This notice covers source packages physically represented in the production
dashboard bundle, generated CSS assets, and generated virtual-runtime helpers. The checked
inventory is `docs/dashboard-bundle-inventory.json`; `scripts/dashboard-package-check.mjs`
compares its JavaScript package list to Vite/Rolldown's production module graph and validates the
manual generated-output attributions.

## Emitted package modules

| Package | License | Attribution |
| --- | --- | --- |
| `lucide-react@0.468.0` | ISC | Portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). All other Lucide copyright is held by Lucide Contributors 2022. |
| `react@19.2.8` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| `react-dom@19.2.8` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |
| `scheduler@0.27.0` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates |

## Generated stylesheet assets

| Asset source | Attribution | License |
| --- | --- | --- |
| Tailwind Preflight, components and utilities emitted from `dashboard/src/styles.css` | `tailwindcss@4.3.3`, Copyright (c) Tailwind Labs, Inc. | MIT |

## Generated virtual-runtime helpers

| Virtual module | Attribution | License |
| --- | --- | --- |
| `rolldown/runtime.js` | `rolldown@1.2.9`, Copyright (c) 2024-present VoidZero Inc. & Contributors | MIT |
| `vite/modulepreload-polyfill.js` | `vite@8.3.0`, Copyright (c) 2019-present VoidZero, Inc. and Vite contributors | MIT |

Dependencies not physically included in the dashboard bundle are not represented by this
dashboard-specific notice.

## MIT License

MIT License

Copyright (c) the copyright holders identified above

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ISC License

Copyright (c) the copyright holders identified above

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
