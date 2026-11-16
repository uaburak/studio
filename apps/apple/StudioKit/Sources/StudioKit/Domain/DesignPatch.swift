import CoreGraphics
import Foundation

/// One design-kit patch operation (`packages/design-kit/src/patch/ops.ts`) on one
/// slide, as `content.render` takes it in `patches`: `{ "slide": 0, "op": "setText", ... }`.
///
/// Every edit in the post editor becomes one or more of these; the worker applies
/// them to the version's HTML, stores a new `manual_edit` version and renders it.
public struct DesignPatch: Sendable, Hashable {
    public enum Operation: Sendable, Hashable {
        /// Plain text; `\n` becomes `<br>`.
        case setText(layer: String, text: String)
        case setVisibility(layer: String, hidden: Bool)
        /// Absolute editor transform of a layer: `translate` in artboard px (zero removes it)
        /// and a uniform `scale` (1 removes it). Siblings never reflow.
        case transform(layer: String, translate: CGPoint, scale: Double)
        /// Replace an image layer's picture (`src` under `/media/`).
        case replaceImage(layer: String, src: String)
        /// Put a picture into an image slot (empty or filled).
        case fillSlot(layer: String, src: String)
        /// Empty a filled slot again.
        case clearSlot(layer: String)
    }

    /// 0-based slide index.
    public var slide: Int
    public var operation: Operation

    public init(slide: Int, _ operation: Operation) {
        self.slide = slide
        self.operation = operation
    }

    public var layer: String {
        switch operation {
        case .setText(let layer, _), .setVisibility(let layer, _), .transform(let layer, _, _),
             .replaceImage(let layer, _), .fillSlot(let layer, _), .clearSlot(let layer):
            layer
        }
    }

    /// The op's name in design-kit (`setText`, `transform`, ...).
    public var opName: String {
        switch operation {
        case .setText: "setText"
        case .setVisibility: "setVisibility"
        case .transform: "transform"
        case .replaceImage: "replaceImage"
        case .fillSlot: "fillSlot"
        case .clearSlot: "clearSlot"
        }
    }

    /// Short Turkish description for undo menus and version notes.
    public var label: String {
        switch operation {
        case .setText: "Metni değiştir"
        case .setVisibility(_, let hidden): hidden ? "Katmanı gizle" : "Katmanı göster"
        case .transform: "Taşı ve boyutlandır"
        case .replaceImage: "Görseli değiştir"
        case .fillSlot: "Yuvayı doldur"
        case .clearSlot: "Yuvayı boşalt"
        }
    }

    /// Wire JSON for `content.render` `patches`.
    public func toJSONObject() -> JSONObject {
        var object: JSONObject = ["slide": .number(Double(slide)), "op": .string(opName), "layer": .string(layer)]
        switch operation {
        case .setText(_, let text):
            object["text"] = .string(text)
        case .setVisibility(_, let hidden):
            object["hidden"] = .bool(hidden)
        case .transform(_, let translate, let scale):
            let x = Self.round(translate.x), y = Self.round(translate.y)
            object["translate"] = x == 0 && y == 0 ? .null : .object(["x": .number(x), "y": .number(y)])
            let s = (scale * 1000).rounded() / 1000
            object["scale"] = s == 1 ? .null : .number(s)
        case .replaceImage(_, let src), .fillSlot(_, let src):
            object["src"] = .string(src)
        case .clearSlot:
            break
        }
        return object
    }

    /// Artboard px with one decimal (design-kit accepts -10000...10000).
    static func round(_ value: CGFloat) -> Double {
        let clamped = min(10_000, max(-10_000, Double(value)))
        return (clamped * 10).rounded() / 10
    }

    /// `/media/<assetId><ext>`: the contract's path for an uploaded picture. The
    /// renderer serves it from the asset (`GET /api/assets/<id>/content`).
    public static func mediaSource(assetId: EntityID, mimeType: String?) -> String {
        let ext: String = switch mimeType?.lowercased() {
        case "image/png": ".png"
        case "image/webp": ".webp"
        case "image/gif": ".gif"
        case "image/avif": ".avif"
        default: ".jpg"
        }
        let encoded = assetId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? assetId
        return "/media/\(encoded)\(ext)"
    }
}

/// The editor transform a layer carries in its inline style (`translate: 12px -8px; scale: 1.1`).
public struct LayerTransform: Sendable, Hashable {
    public var translate: CGPoint
    public var scale: Double

    public init(translate: CGPoint = .zero, scale: Double = 1) {
        self.translate = translate
        self.scale = scale
    }

    public static let identity = LayerTransform()

    /// Parse the individual transform properties from an inline `style` attribute.
    public init(style: String?) {
        self.init()
        guard let style else { return }
        for declaration in style.split(separator: ";") {
            let parts = declaration.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            guard parts.count == 2 else { continue }
            let values = parts[1].split(whereSeparator: { $0 == " " || $0 == "," }).map(String.init)
            switch parts[0].lowercased() {
            case "translate":
                let x = values.first.flatMap(Self.pixels) ?? 0
                let y = values.count > 1 ? (Self.pixels(values[1]) ?? 0) : 0
                translate = CGPoint(x: x, y: y)
            case "scale":
                if let first = values.first.flatMap({ Double($0) }) { scale = first }
            default:
                continue
            }
        }
    }

    private static func pixels(_ token: String) -> Double? {
        let trimmed = token.hasSuffix("px") ? String(token.dropLast(2)) : token
        return Double(trimmed)
    }
}

/// Geometry of the editor canvas: the rendered slide is drawn into a view rect;
/// layer boxes come in artboard px.
public struct SlideCanvasGeometry: Sendable, Hashable {
    /// Artboard size in CSS px (e.g. 1080×1350).
    public var artboard: CGSize
    /// Where the slide image is drawn in the view.
    public var imageRect: CGRect

    public init(artboard: CGSize, imageRect: CGRect) {
        self.artboard = artboard
        self.imageRect = imageRect
    }

    /// The largest rect of the artboard's aspect that fits `bounds`, centred.
    public static func fitting(artboard: CGSize, in bounds: CGRect) -> SlideCanvasGeometry {
        guard artboard.width > 0, artboard.height > 0, bounds.width > 0, bounds.height > 0 else {
            return SlideCanvasGeometry(artboard: artboard, imageRect: bounds)
        }
        let scale = min(bounds.width / artboard.width, bounds.height / artboard.height)
        let size = CGSize(width: artboard.width * scale, height: artboard.height * scale)
        let origin = CGPoint(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2)
        return SlideCanvasGeometry(artboard: artboard, imageRect: CGRect(origin: origin, size: size))
    }

    /// View points per artboard px.
    public var scale: CGFloat { artboard.width > 0 ? imageRect.width / artboard.width : 1 }

    /// Artboard rect -> view rect (top-left origin in both).
    public func viewRect(_ box: CGRect) -> CGRect {
        CGRect(
            x: imageRect.minX + box.minX * scale,
            y: imageRect.minY + box.minY * scale,
            width: box.width * scale,
            height: box.height * scale)
    }

    /// View point -> artboard point.
    public func artboardPoint(_ point: CGPoint) -> CGPoint {
        CGPoint(x: (point.x - imageRect.minX) / scale, y: (point.y - imageRect.minY) / scale)
    }

    /// View distance -> artboard distance.
    public func artboardDelta(_ delta: CGSize) -> CGSize {
        CGSize(width: delta.width / scale, height: delta.height / scale)
    }

    /// The topmost selectable layer under an artboard point: the smallest visible box
    /// that contains it (backgrounds and the groups around a layer lose to the layer).
    public static func hitTest(_ point: CGPoint, in boxes: [SlideLayerBox], skipping skipped: Set<String> = []) -> SlideLayerBox? {
        boxes
            .filter { $0.visible && $0.w > 0 && $0.h > 0 && !skipped.contains($0.id) && $0.rect.contains(point) }
            .min { lhs, rhs in
                let a = lhs.w * lhs.h, b = rhs.w * rhs.h
                if a != b { return a < b }
                return lhs.role != "background" && rhs.role == "background"
            }
    }
}

/// Editor moves and resizes, expressed as the absolute layer transform to store.
public enum LayerTransformMath {
    /// Moving by `delta` artboard px.
    public static func moved(_ current: LayerTransform, by delta: CGSize) -> LayerTransform {
        LayerTransform(
            translate: CGPoint(x: current.translate.x + delta.width, y: current.translate.y + delta.height),
            scale: current.scale)
    }

    /// Resizing a box (measured, transforms included) by `factor` with its top-left corner
    /// fixed. CSS `scale` grows around the box centre, so the translate compensates.
    public static func resized(_ current: LayerTransform, box: CGRect, factor: Double) -> LayerTransform {
        let k = max(0.05, factor)
        let newScale = min(20, max(0.05, current.scale * k))
        let applied = current.scale == 0 ? k : newScale / current.scale
        let dx = box.width * (applied - 1) / 2
        let dy = box.height * (applied - 1) / 2
        return LayerTransform(
            translate: CGPoint(x: current.translate.x + dx, y: current.translate.y + dy),
            scale: newScale)
    }

    /// Where a box ends up after `moved` / `resized` (for the live outline while dragging).
    public static func previewBox(_ box: CGRect, from current: LayerTransform, to next: LayerTransform) -> CGRect {
        let k = current.scale == 0 ? 1 : next.scale / current.scale
        let center = CGPoint(
            x: box.midX + (next.translate.x - current.translate.x),
            y: box.midY + (next.translate.y - current.translate.y))
        let size = CGSize(width: box.width * k, height: box.height * k)
        return CGRect(x: center.x - size.width / 2, y: center.y - size.height / 2, width: size.width, height: size.height)
    }
}
