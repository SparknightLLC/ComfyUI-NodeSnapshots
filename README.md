# ComfyUI-NodeSnapshots

Version **0.1.1** · [Changelog](CHANGELOG.md) · [MIT license](LICENSE)

https://github.com/user-attachments/assets/76b612bd-ea09-4bff-b314-f8e5c09d2dd0

An experimental frontend extension from Sparknight for smoother large-workflow navigation.

ComfyUI's frontend renders your visible links and nodes at all times. When you pan or drag in a congested graph, **it can easily drop your framerate to the single digits** - especially in Nodes 2.0.

This extension replaces expensive computations with bitmap images of your nodes and links. Since the content of these objects are generally static, we can rely on image placeholders except when performing actions directly on an object.

The performance improvement is substantial. In a ~350 node workflow, a busy section of the graph averaged 20 FPS, and it now averages around 60.

My original version of this idea took a single screenshot of the entire graph. That version was actually faster, except for one major issue: capturing the whole graph at once caused a noticeable pause, even with idle scheduling and reduced resolution. NodeSnapshots makes that approach practical by capturing individual nodes in small idle batches and reusing each image independently.

**Legacy and Nodes 2.0 both support individual bitmap snapshots.** Nodes 2.0 capture is experimental and also supports native offscreen rendering suppression. No inference nodes, Python dependencies, model changes, or workflow format changes are required.

## Install

Place this folder under `ComfyUI/custom_nodes/ComfyUI-NodeSnapshots`, restart ComfyUI, and refresh the browser. Open **Settings > NodeSnapshots**.

Other extensions that replace the same drawing methods may interact with NodeSnapshots.

## Legacy snapshots

- Visible eligible nodes are rendered individually into transparent canvases during idle time.
- Panning, zooming, node/group dragging, and node/group resizing reuse those images. Links have a separate viewport cache described below. **Show node snapshots while idle** enables continuous reuse outside those interactions and defaults to on.
- Hovered/selected/edited nodes, expanded DOM widgets, media previews, and the node that is executing stay live. Collapsed textarea/Note nodes and ordinary subgraph nodes are eligible; subgraph preview content stays live. Hover and selection temporarily bypass an image without deleting it; actual edits invalidate only the affected node.
- Node values, size, connections, and drawing settings are checked before reuse. Position, viewport zoom, and entering/leaving subgraphs do not invalidate images. While the viewport is moving, that check is refreshed at most every 100 ms instead of on every frame, and it returns to every frame as soon as the interaction ends. Retained images from different subgraphs share the same memory budget. Snapshots are captured at full detail in graph coordinates and scaled for display; substantial enlargement can soften text. The configurable capture pixel ratio controls that tradeoff.
- Palette changes, loaded fonts, and workflow replacement clear the cache. A first subgraph visit can load additional UI fonts and trigger a font refresh. Unrelated body cursor/style changes and scheduling or memory-budget increases do not clear it.
- Running a prompt does not clear the cache. Nodes that report progress or receive outputs are drawn live, everything else keeps its image, and new captures wait until the run ends. Panning during a run therefore reuses snapshots instead of redrawing the graph. **Release images while executing** frees the stored images when a run starts instead, trading navigation speed during the run for their bitmap memory.
- Captures are scheduled in small batches. There is no full-graph capture, image encoding, or pixel-read validation.
- Images stay in memory, with least-recently-used eviction. There is no disk cache or initial blocking capture. **Precache offscreen nodes** applies to both renderers and defaults to off. Visible nodes take priority; optional offscreen preparation uses spare bitmap capacity without evicting visible images. Nodes 2.0 can only capture mounted DOM nodes.
- Slow or failing nodes stay live for the rest of their object lifetime. Custom drawing may have unreported dependencies or side effects; add problematic node types to the exclusion setting.

By default, node snapshots also appear while idle. Turn **Show node snapshots while idle** off for navigation-only reuse. Custom drawing callbacks that perform updates may require exclusion; **Exclude pinned nodes** lets you keep individual problem nodes live without excluding their whole type. The idle refresh interval schedules replacements for aged images without discarding them mid-interaction; `0` disables periodic refresh. Content edits invalidate the affected node within the navigation check described above, or immediately at any other time. Custom animations and undeclared dependencies can linger through a long interaction, and a node that only changes appearance during a run is no longer masked by an execution-wide clear; exclude those node types. Oversized nodes remain live.

**Mark cached nodes (camera)** bakes a camera icon in the theme's primary accent color (the Run button color) into snapshots during capture. It appears only when the node is actually drawn from its image, and disappears when the node is rendered live. Reuse still performs the same single image draw, with no extra marker drawing or extra image layer. Changing this setting clears and rebuilds the cache; wait for warm-up before comparing performance. The marker scales with the image.

## Nodes 2.0 compatibility and limitations

Support is experimental and partial, validated against frontend 1.55.9. Standard text/form nodes can be cached, but arbitrary custom widgets are not guaranteed to work. Keep a problematic node live with **Exclude pinned nodes** or **Excluded node types**.

**Experimental node snapshots** clones a visible node's inner DOM with its computed styles, embeds same-origin fonts in an SVG, and draws that into a bitmap. Preparation yields between elements. Supported nodes reuse that image during navigation; **Show node snapshots while idle** enables continuous reuse. The original Vue components remain mounted, and hover, focus, selection, and execution reveal the live content. Native state overlays remain live; links use the separate link-cache policy.

The camera marker is baked into these images too. Both renderers share the pixel ratio, bitmap dimension, memory, refresh, scheduling, and exclusion settings. Offscreen capture is optional, with visible nodes prioritized. Images retained across subgraph navigation are reattached only after node dimensions, DOM structure/styles, and live form values match. Changed or unsupported nodes remain live.

### Content and performance limitations

This is not a general-purpose webpage screenshot engine. Media/canvas content, shadow DOM, generated pseudo-element content, animation, scrolled controls, external style resources, and unsupported CSS fall back to live rendering. Text inputs and textareas are supported when their styles can be captured. Custom extensions may need exclusions. Vue updates and layout still run, so a screenshot is not a promise of a speedup. Styles inherited from custom ancestors or unreported programmatic widget changes may require a manual clear or periodic refresh.

NodeSnapshots applies `content-visibility: auto` to node **bodies**, preserving the native headers, ports, editing components, and graph model. It measures each body while live before enabling containment, so offscreen bodies can retain their size. Hovered, focused, selected, and executing nodes remain live through the native state overlay.

The browser can skip offscreen body layout and paint. Vue reactivity, application JavaScript, and links continue to run. ComfyUI or another extension querying offscreen geometry may force rendering and reduce the benefit. Graphs where all nodes fit onscreen may see little benefit.

**Warm-up, not steady-state drawing, is the known weak point for Nodes 2.0.** Filling the cache means cloning and rasterizing every supported node, and while `content-visibility` is being applied the browser keeps reporting small body size changes, which discard images that were already captured and queue them again. Diagnostics show this as repeated `resize` invalidations in `vue.invalidations` and `vue.last_invalidation`, and captures keep accumulating on the same nodes for as long as the graph stays idle. On the benchmark workflow the dense view needed about 22 seconds of idle time to warm, and the whole-graph view still had roughly 100 of 344 nodes uncaptured when the 45-second cap stopped warm-up, so those frame rates are a lower bound. A future version should tolerate sub-pixel body size changes, stop retrying nodes that cannot be captured, and make the DOM structure check cheaper; once images are attached, drawing is no longer the expensive part.

**Reduce shadows during navigation** temporarily removes node drop shadows during panning and zooming. The bitmap budget caps retained canvas pixel storage, not browser compositor allocations, temporary DOM/SVG data, font resources, or image-decoder memory. No new package or remote capture service is required.

### Capture speed

Nodes 2.0 snapshots require computed-style reads for every element, DOM cloning, SVG serialization, font embedding, image decoding, and rasterization. Legacy can call the existing canvas node renderer directly. Slower Nodes 2.0 capture is therefore expected; the difference is not a fixed multiple, and some of the overhead is avoidable. Font stylesheet assembly is reused between nodes; preparation yields between elements instead of blocking on an entire node. Diagnostics expose cumulative `vue.prepare_ms` and `vue.decode_ms` to distinguish preparation from asynchronous decoding. These include interrupted work and are not end-to-end FPS measurements.

Capturing offscreen DOM content temporarily forces that node's body to render, so enabling it trades additional background work and memory for fewer uncached nodes when you pan.

## Link snapshots

**Link snapshots** caches a transparent image of the current viewport plus a configurable **Link overscan (px)** margin on each side (512 screen pixels by default). Long links are clipped to this region, so their graph-space length never creates a giant bitmap. Each dimension is capped at 4096 pixels, and a separate **Link bitmap budget** defaults to 32 MiB, accounting for replacement storage. Large viewports are downsampled to fit.

**Show link snapshots while idle** is separate from the node setting and defaults to off. Links return to sharp native drawing when panning stops or 180 ms after the last graph wheel event. The bitmap remains cached and is validated before reuse. Turning this option on also displays link snapshots while idle.

Pans and zooms reuse the layer while it still covers the viewport. Beyond its bounds, links render live until another idle capture. This fallback performs no snapshot geometry checks or capture scheduling while the pointer is held or the canvas is panning. Endpoint movement, resizing, connection/style changes, link interaction, and highlights use native drawing or invalidate the image. This first version also leaves reroutes, floating links, and subgraph links live. Native link hit paths are populated during capture.

During panning, graph revisions, node/link counts, and rendering settings are checked on every link draw. For a snapshot that still covers the viewport, full geometry checks run at most once per 100 ms while those values remain unchanged, and resume on every reuse outside panning. Direct extension edits that emit no change event can therefore appear up to 100 ms later during a pan (or on the next frame if rendering is paused). Pan completion and editing force revalidation. Geometry is compared in reusable scalar storage, without serializing the graph. Hidden links bypass validation and capture; finishing a pan retains an otherwise valid image. One native connection draw remains synchronous during capture. Slow captures use the same cutoff and fall back to live links. Toggle this option to compare your own workflows.

On the standard canvas layout, cached links occupy a separate browser-composited layer between the native background/groups and foreground/nodes. Panning updates its CSS transform instead of drawing the link image and copying the background into the foreground each frame. The existing background canvas is reused; group rendering, node rendering, and native hit testing remain active. Export contexts, links-on-top configurations, and unsupported canvas layouts retain ordinary bitmap drawing. Browser compositor memory is additional to the bitmap budget. Browser screenshots include all layers. While a link snapshot is displayed, the foreground canvas contains only foreground content; extensions exporting that canvas alone should use native idle rendering or disable link snapshots.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| Enable NodeSnapshots | On | Master switch; turning it off releases images and removes DOM optimization styles. |
| Enable Legacy snapshots | On | Enable Legacy capture and reuse. Off means no Legacy snapshots in any interaction mode. |
| Show node snapshots while idle | On | Also use snapshots when not panning, zooming, dragging, or resizing. |
| Mark cached nodes (camera) | Off | Bake a visible debug marker into images; changing this setting rebuilds them. |
| Bitmap memory budget | 256 MiB | RGBA pixel budget, including the next capture. Browser/GPU bookkeeping is extra. |
| Capture batch budget | 3 ms | Yield between Legacy captures or DOM cloning steps. Also limits DOM body registration batches. |
| Idle delay before capture | 50 ms | Wait after user input before starting captures. |
| Slow node cutoff | 32 ms | Reject a slow Legacy capture or DOM cloning step. |
| Maximum bitmap dimension | 2048 px | Keep larger nodes live. |
| Capture pixel ratio | 2 | Fixed pixels per graph unit, independent of zoom. Values 0.5 and 0.75 trade detail for smaller images. Changing it rebuilds images. |
| Idle refresh interval | 0 ms | Refresh aged images when idle, retaining usable images during interactions. `0` disables periodic refresh. |
| Exclude pinned nodes | Off | Keep individually pinned nodes live in both renderers. |
| Precache offscreen nodes | Off | Prepare offscreen nodes after visible candidates, using spare capacity. |
| Release images while executing | Off | Free stored images when a prompt starts. Navigation uses live drawing until the cache warms again after the run. |
| Link snapshots | On | Reuse a bounded viewport image of ordinary links. |
| Show link snapshots while idle | Off | Render sharp native links after navigation; retain the bitmap for the next pan or zoom. |
| Link overscan (px) | 512 | Extra coverage on each side, from 0 to 2048 screen pixels. Larger margins support longer pans but may increase capture time and reduce sharpness within the existing memory/dimension limits. |
| Link bitmap budget | 32 MiB | Separate budget for link-image storage, including replacement. |
| Excluded node types | Empty | Comma-separated exact node type names. |
| Experimental node snapshots | On | Capture supported Nodes 2.0 DOM nodes. |
| Reduce offscreen DOM rendering | On | Enable native Nodes 2.0 body containment. |
| Reduce shadows during navigation | Off | Temporarily simplify Nodes 2.0 shadows. |
| Log capture failures | Off | Log failure summaries without workflow values. |

The scheduling budget is cooperative: **one synchronous node draw, style read, SVG serialization, or image-decode operation cannot be interrupted**. The first unexpectedly slow capture can exceed the budget before that node is excluded. The memory setting measures pixel storage, not total browser memory. Group containers continue to use native drawing: their few rectangles and text are inexpensive, while an image covering the entire group can consume substantial memory.

New defaults do not overwrite saved settings. The renamed node idle-display setting retains its saved value. If you previously saved a different link overscan value, set it to 512 px explicitly to use the new default. Increasing the slow-node cutoff permits previously rejected nodes to retry. A refresh needs room for the old image and its replacement together; if that cannot fit, the old image remains usable.

## Workflow benchmarks

A release benchmark compares the whole extension with its master switch **off** and **on** in the same visible Edge window, using the same camera, zoom, and pan path. It ran on a **private 344-node, 320-link workflow** (23 groups) that is not distributed with the extension, inside a real ComfyUI **0.34.0** instance on frontend **1.55.9** with 136 registered extensions. The machine was an Intel Core i9-10900K with 64 GiB RAM and a GeForce RTX 3090 (ANGLE D3D11), at 1920 x 1080 and device pixel ratio 1. A Krea 2 checkpoint stayed loaded in VRAM for the whole run without generating, which leaves less video memory for the browser's own compositing; treat the frame rates below as conservative.

Each trial pans with a real middle-button drag of +/-300 horizontal and +/-30 vertical screen pixels for 7 seconds. Off/on pairs alternate their order and reuse the same viewport, and enabled trials finish warming their bitmaps first. **Dense** is the densest node-rectangle region at 65% zoom, with roughly 100-130 nodes visible. **Overview** is the whole graph, with roughly 330-344 nodes visible. All trials used the shipped defaults: node snapshots are also displayed while idle, and links return to sharp native drawing while idle with a retained 512-pixel-overscan bitmap.

| Renderer | View | Extension | Median FPS (range) | Comfy FPS counter | Main-thread draw, mean / p95 | Frames over 33 ms | Cached node images |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| Legacy | Dense | Off | 21.2 (18.9-21.3) | 21.5 | 42.6 / 47.9 ms | 100% | None |
| Legacy | Dense | On | 66.2 (58.1-67.4) | 56.2 | 8.6 / 21.6 ms | 2% | 119 (55 MiB) |
| Legacy | Overview | Off | 15.1 (15.1-15.3) | 15.2 | 62.6 / 66.3 ms | 99% | None |
| Legacy | Overview | On | 68.2 (63.7-70.3) | 62.9 | 10.9 / 34.3 ms | 10% | 334 (148 MiB) |
| Nodes 2.0 | Dense | Off | 25.0 (21.2-25.2) | 25.4 | 22.5 / 25.7 ms | 99% | None |
| Nodes 2.0 | Dense | On | 24.7 (21.5-26.9) | 27.3 | 8.8 / 12.4 ms | 75% | 123 (35 MiB) |
| Nodes 2.0 | Overview | Off | 18.0 (17.2-20.4) | 18.4 | 34.1 / 38.4 ms | 99% | None |
| Nodes 2.0 | Overview | On | 22.2 (21.0-22.7) | 23.1 | 17.3 / 24.2 ms | 98% | 234 (48 MiB) |

Median FPS is computed from animation-frame intervals across the three trials in each row; the Comfy counter is the median of the frontend's own FPS samples. Draw time measures main-thread JavaScript and drawing submission for one canvas frame, not GPU composition. During the Legacy runs 86% of node draws in the dense view and 97% in the overview were served from images, leaving about 4,300 and 2,600 live node draws respectively across the 7-second pan; the link bitmap served about 99% of link draws in both views. Warming the cache took about 5 seconds in the dense view and 9 seconds in the overview. Legacy panning now runs at 58-70 FPS in these views, with image drawing taking under 11 ms of main-thread time per frame.

Nodes 2.0 is noisier. Its dense view warmed in about 22 seconds and the overview still reached the 45-second cap with roughly 100 of 344 nodes uncaptured, so the overview trials began measuring while node capture was still running and should be read as a lower bound. The first dense enabled trial was slower than the two later disabled runs (21.5 against 25.0 and 25.2 FPS), while its repeats reached 26.9 and 24.7 FPS, so the dense view shows no reliable gain there. Nodes 2.0 also reports DOM captures rather than node cache hits, so its improvement shows up in draw time and script work instead of in a hit counter.

These numbers come from one dense, heavily overlapping workflow, so they are evidence that caching removes most per-frame drawing work here rather than a promise for every graph. Compare the same workflow with the master switch off and on, and let the cache warm before measuring. [Per-trial measurements](docs/benchmarks-v0.1.1.json).

## Diagnostics and verification

The browser console provides:

```js
NodeSnapshots.getStats()
NodeSnapshots.clearCache()
```

Statistics include cache hits, live draws, bitmap bytes, capture duration, scheduling overruns, content invalidations, reused content checks, the last whole-cache clear reason, managed/skipped DOM bodies, DOM captures/restorations, and active DOM snapshots. Top-level bitmap counts and bytes cover node snapshots in both renderers; `links` reports its separate hit, capture, duration, and pixel-storage statistics. Canvas draw timing measures main-thread JavaScript and drawing submission; it is not an FPS or GPU-composition measurement.

Compare the same workflow, viewport, zoom, and browser with the master switch on and off. Let the graph sit idle before measuring cached panning. Check text, slots, previews, editing, subgraphs, execution, and renderer switching with your other extensions enabled.

Unit tests use the Node.js standard library:

```sh
node --test tests/cache.test.mjs tests/scheduler.test.mjs tests/signature.test.mjs tests/settings.test.mjs tests/links.test.mjs
```

`tests/browser.mjs` uses an existing Playwright installation and a running **disposable** ComfyUI instance. It replaces that instance's workflow and settings. Set `NODESNAPSHOTS_TEST_URL` to the isolated server, optionally `PLAYWRIGHT_MODULE` to the installed module and `BROWSER_EXECUTABLE` to a browser executable, then run `node tests/browser.mjs`. It checks real frontend capture, live/cached pixels, snapshot retention and reuse during execution, Nodes 2.0 geometry, and disable cleanup.

This is experimental code using internal rendering methods and Nodes 2.0 DOM selectors. It is not a stable frontend API integration or a guarantee of faster navigation on every workflow.

Validation uses ComfyUI frontend **1.55.9** (commit `7452fd7e76281b5e7f9d178d2811cb9fe8c53fb5`) in headless Microsoft Edge on Windows, with an isolated user directory and only NodeSnapshots enabled. The browser test covers image retention across zoom/movement/hover, content invalidation, continuous reuse, refresh during idle, baked debug markers, retention and reuse during execution, subgraph round trips in both renderers, collapsed Notes and plain subgraphs, and renderer switching. Nodes 2.0 also checks expanded Note editing, sub-1 pixel ratios, unsupported-content fallback, visible raster pixels and baked markers, skips the far-offscreen body, and retains node dimensions; no Nodes 2.0 speedup is claimed from this correctness check. `tests/followups.browser.mjs` additionally covers pinned exclusions, offscreen capture, and a 120-link graph with an extremely long crossing link. It compares live/cached pixels, panning reuse, and endpoint invalidation in both renderers. `tests/link-layer.browser.mjs` compares full-page screenshots with native links to check group/link/node ordering, zoom, resize, and layer cleanup in both renderers. These synthetic tests are not production-workflow FPS benchmarks.

The camera uses the [Phosphor Icons](https://github.com/phosphor-icons/core) camera-fill SVG, recolored with a dark backing to cover the node icon. Its MIT license is included in `PHOSPHOR-LICENSE.txt`.
