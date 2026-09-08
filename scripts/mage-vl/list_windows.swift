import CoreGraphics
import Foundation

let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
let windows = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
let result = windows.compactMap { window -> [String: Any]? in
    guard let id = window[kCGWindowNumber as String] as? UInt32,
          let layer = window[kCGWindowLayer as String] as? Int,
          layer == 0,
          let owner = window[kCGWindowOwnerName as String] as? String else {
        return nil
    }
    let title = (window[kCGWindowName as String] as? String) ?? ""
    return ["id": id, "owner": owner, "title": title]
}
let data = try JSONSerialization.data(withJSONObject: result, options: [])
FileHandle.standardOutput.write(data)
