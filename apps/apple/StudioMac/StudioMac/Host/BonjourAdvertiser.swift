import dnssd
import Foundation

/// Advertises the LAN gateway as `_studio._tcp` (TXT: name, api, pairing, id, addr, port) so
/// phones on the same network find the Mac (StudioKit `StudioBrowser`). Uses
/// `DNSServiceRegister`: it announces a port another process listens on.
@MainActor
final class BonjourAdvertiser {
    static let serviceType = "_studio._tcp"
    /// TXT `api`: must match `LAN_API_VERSION` (contract) / `StudioBrowser.supportedAPIVersion`.
    static let apiVersion = "1"

    private var ref: DNSServiceRef?
    private(set) var advertisedPort: Int?

    var isAdvertising: Bool { ref != nil }

    /// Returns false when mDNSResponder refused the registration.
    @discardableResult
    func start(name: String, port: Int, macId: String? = nil) -> Bool {
        stop()
        var txt = TXTRecordRef()
        TXTRecordCreate(&txt, 0, nil)
        defer { TXTRecordDeallocate(&txt) }
        // `addr` / `port`: the Mac's LAN IPv4 addresses and the gateway port, so a phone
        // can still reach the Mac when resolving the Bonjour endpoint itself fails.
        let addresses = HostEnvironment.lanAddresses().prefix(4).joined(separator: ",")
        // `id`: the host id, so a phone recognises its Mac even after a rename.
        var entries = ["name": name, "api": Self.apiVersion, "pairing": "required",
                       "addr": addresses, "port": String(port)]
        if let macId, !macId.isEmpty { entries["id"] = macId }
        for (key, value) in entries {
            let bytes = Array(value.utf8.prefix(255))
            _ = bytes.withUnsafeBufferPointer { TXTRecordSetValue(&txt, key, UInt8(bytes.count), $0.baseAddress) }
        }
        var service: DNSServiceRef?
        let error = DNSServiceRegister(
            &service, 0, 0, name, Self.serviceType, nil, nil,
            UInt16(port).bigEndian, TXTRecordGetLength(&txt), TXTRecordGetBytesPtr(&txt), nil, nil
        )
        guard error == DNSServiceErrorType(kDNSServiceErr_NoError), let service else { return false }
        DNSServiceSetDispatchQueue(service, .main)
        ref = service
        advertisedPort = port
        return true
    }

    func stop() {
        if let ref { DNSServiceRefDeallocate(ref) }
        ref = nil
        advertisedPort = nil
    }

    /// The Mac's user-visible name ("Burak's MacBook Pro").
    static var computerName: String {
        Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    }
}
