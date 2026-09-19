const UNSUPPORTED = "canvas,video,audio,img,iframe,object,embed,script,link,style,use,[contenteditable='true']";
const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// One element/rule per yield: the owner schedules this work within its idle budget.
export function* clone_styled_node(source, width, height)
{
	if (source.matches(UNSUPPORTED) || source.querySelector(UNSUPPORTED)) throw new Error("unsupported_content");
	const fonts = new Set();
	const root = source.cloneNode(false);
	const pending = [[source, root]];
	while (pending.length)
	{
		const [live, clone] = pending.pop();
		if (live.shadowRoot || live.scrollTop || live.scrollLeft) throw new Error("unsupported_content");
		const computed = getComputedStyle(live);
		if (computed.animationName !== "none" || computed.backdropFilter !== "none") throw new Error("dynamic_style");
		for (const pseudo of ["::before", "::after"])
		{
			const content = getComputedStyle(live, pseudo).content;
			if (content && content !== "none" && content !== "normal" && content !== '""') throw new Error("pseudo_content");
		}
		for (const attribute of [...clone.attributes])
		{
			if (/^on/i.test(attribute.name) || ["id", "class", "style", "autofocus"].includes(attribute.name)) clone.removeAttribute(attribute.name);
		}
		const declarations = [];
		for (const name of computed)
		{
			if (name.startsWith("--")) continue;
			const value = computed.getPropertyValue(name);
			if (value.includes("url(") && [...value.matchAll(/url\(\s*['"]?([^)'"\s]+)/gi)].some((match) => !match[1].startsWith("data:")))
				throw new Error("external_style_resource");
			declarations.push(`${name}:${value}`);
		}
		clone.style.cssText = declarations.join(";");
		clone.style.setProperty("content-visibility", "visible");
		clone.style.setProperty("contain", "none");
		clone.style.setProperty("transition", "none");
		fonts.add(computed.fontFamily);
		if (live instanceof HTMLInputElement)
		{
			clone.setAttribute("value", live.value);
			clone.toggleAttribute("checked", live.checked);
		}
		if (live instanceof HTMLTextAreaElement) clone.textContent = live.value;
		else
		{
			for (const child of live.childNodes)
			{
				const copy = child.cloneNode(false);
				clone.append(copy);
				if (child instanceof Element) pending.push([child, copy]);
			}
		}
		yield;
	}
	Object.assign(root.style, {
		position: "relative", left: "0px", top: "0px", margin: "0px", transform: "none",
		width: `${width}px`, height: `${height}px`, minWidth: "0px", minHeight: "0px", visibility: "visible"
	});
	return { root, fonts };
}

export class DomRasterizer
{
	constructor()
	{
		this.resources = new Map();
		this.font_rules = null;
		this.font_styles = new Map();
	}

	*prepare(source, width, height)
	{
		const clone = yield* clone_styled_node(source, width, height);
		if (!this.font_rules)
		{
			const faces = [];
			for (const sheet of document.styleSheets)
			{
				let rules;
				try { rules = [...sheet.cssRules]; }
				catch { continue; }
				while (rules.length)
				{
					const rule = rules.pop();
					if (rule.type === CSSRule.FONT_FACE_RULE)
						faces.push({ family: rule.style.fontFamily.replaceAll(/['"]/g, ""), css: rule.cssText, base: sheet.href ?? location.href });
					else if (rule.cssRules) rules.push(...rule.cssRules);
					yield;
				}
			}
			this.font_rules = faces;
		}
		return clone;
	}

	async font_css(families)
	{
		const wanted = new Set([...families].flatMap((family) => family.split(",").map((name) => name.trim().replaceAll(/['"]/g, ""))));
		const key = JSON.stringify([...wanted].sort());
		if (this.font_styles.has(key)) return this.font_styles.get(key);
		const matches = this.font_rules.filter((rule) => wanted.has(rule.family)).map((rule) => this.embed_font(rule.css, rule.base));
		const result = Promise.all(matches).then((rules) => rules.join("\n"));
		this.font_styles.set(key, result);
		return result;
	}

	async embed_font(css, base)
	{
		const urls = [...css.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)];
		for (const match of urls)
		{
			const url = new URL(match[1], base);
			if (url.protocol === "data:") continue;
			if (url.origin !== location.origin) throw new Error("external_font");
			if (!this.resources.has(url.href))
			{
				this.resources.set(url.href, fetch(url.href).then((response) =>
				{
					if (!response.ok) throw new Error("font_load");
					return response.blob();
				}).then((blob) => new Promise((resolve, reject) =>
				{
					const reader = new FileReader();
					reader.onload = () => resolve(reader.result);
					reader.onerror = reject;
					reader.readAsDataURL(blob);
				})));
			}
			css = css.replace(match[0], `url("${await this.resources.get(url.href)}")`);
		}
		return css;
	}

	async decode(clone, width, height)
	{
		const css = await this.font_css(clone.fonts);
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));
		const foreign = document.createElementNS(SVG_NS, "foreignObject");
		foreign.setAttribute("width", "100%");
		foreign.setAttribute("height", "100%");
		const style = document.createElementNS(HTML_NS, "style");
		style.textContent = css;
		clone.root.prepend(style);
		foreign.append(clone.root);
		svg.append(foreign);
		const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml;charset=utf-8" }));
		try
		{
			const image = new Image();
			image.src = url;
			await image.decode();
			return image;
		}
		finally { URL.revokeObjectURL(url); }
	}
}
