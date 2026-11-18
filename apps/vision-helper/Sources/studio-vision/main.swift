// studio-vision: reads one JSON request on stdin, writes one JSON response on stdout.
// `studio-vision version` answers without stdin (a quick check that the binary runs).
// Exit code 0 when `ok`, 1 when the request failed (the JSON says why).
import Foundation
import VisionCore

let arguments = CommandLine.arguments.dropFirst()
let input: Data
if arguments.first == "version" {
    input = Data(#"{"command":"version"}"#.utf8)
} else {
    input = FileHandle.standardInput.readDataToEndOfFile()
}

let response = handle(json: input)
FileHandle.standardOutput.write(encode(response))
FileHandle.standardOutput.write(Data("\n".utf8))
exit(response.ok ? 0 : 1)
