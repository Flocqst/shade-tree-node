# Three.js vendor note

This directory contains the browser ES-module build of Three.js `0.185.1`,
copied from the published npm package `three@0.185.1`.

- npm integrity: `sha512-5aojFCXKwnjBRZvUnt3WFfEcvUJgkN5LlijRFN95hMy8WVkG4I0QNcJE+OuWvuJ0bOdStrbfXn0pkd6/QyiAlg==`
- upstream: <https://github.com/mrdoob/three.js>
- license: MIT; see `LICENSE.txt`

The files are hosted locally so the landing-page scene has no runtime CDN
dependency. Update the versioned directory and the import in `site.js`
together.
