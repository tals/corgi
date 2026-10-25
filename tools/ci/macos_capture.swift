import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
if arguments.count > 2 && arguments[1] == "inspect" {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: arguments[2])),
          let bitmap = NSBitmapImageRep(data: data) else {
        fatalError("Screenshot could not be decoded")
    }
    var magenta = 0
    for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
        for x in stride(from: 0, to: bitmap.pixelsWide, by: 2) {
            if let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB),
               color.redComponent > 0.75, color.greenComponent < 0.3,
               color.blueComponent > 0.75 {
                magenta += 1
            }
        }
    }
    print("{\"width\":\(bitmap.pixelsWide),\"height\":\(bitmap.pixelsHigh),\"magentaSamples\":\(magenta)}")
} else {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    let report: [String: Any] = [
        "screenCaptureAllowed": CGPreflightScreenCaptureAccess(),
        "windows": windows,
    ]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(data: data, encoding: .utf8)!)
}
