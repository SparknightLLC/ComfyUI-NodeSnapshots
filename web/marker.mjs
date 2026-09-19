// Resolve the theme and decode the SVG once, never during snapshot reuse.
let camera;
let source;
let generation = 0;
export async function load_camera()
{
	const current_generation = ++generation;
	const probe = document.createElement("span");
	probe.style.cssText = "display:none;color:var(--primary-background,var(--p-primary-color,#0b8ce9))";
	document.body.append(probe);
	const color = getComputedStyle(probe).color;
	probe.remove();
	try
	{
		source ??= fetch(new URL("./camera.svg", import.meta.url)).then((response) =>
		{
			if (!response.ok) throw new Error("camera_asset");
			return response.text();
		});
		const svg = new DOMParser().parseFromString(await source, "image/svg+xml");
		svg.documentElement.setAttribute("fill", color);
		const image = new Image();
		image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
		await image.decode();
		if (generation === current_generation) camera = image;
	}
	catch { console.warn("NodeSnapshots: camera marker could not load."); }
}

export function draw_camera(ctx, x, y, size = 20)
{
	if (!camera?.naturalWidth) return;
	ctx.save();
	ctx.globalAlpha = 1;
	ctx.shadowColor = "transparent";
	ctx.drawImage(camera, x, y, size, size);
	ctx.restore();
}
