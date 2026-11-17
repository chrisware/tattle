import CoreAudio
import Foundation
import Testing
@testable import tattle_capture

@Suite struct DevicesTests {
    @Test func namesEveryTransport() {
        let cases: [(UInt32, String)] = [
            (kAudioDeviceTransportTypeBuiltIn, "builtin"),
            (kAudioDeviceTransportTypeUSB, "usb"),
            (kAudioDeviceTransportTypeBluetooth, "bluetooth"),
            (kAudioDeviceTransportTypeBluetoothLE, "bluetooth"),
            (kAudioDeviceTransportTypeVirtual, "virtual"),
            (kAudioDeviceTransportTypeAggregate, "aggregate"),
            (kAudioDeviceTransportTypeAirPlay, "airplay"),
            (kAudioDeviceTransportTypeHDMI, "display"),
            (kAudioDeviceTransportTypeDisplayPort, "display"),
            (kAudioDeviceTransportTypeThunderbolt, "thunderbolt"),
            (kAudioDeviceTransportTypeContinuityCaptureWired, "continuity"),
            (kAudioDeviceTransportTypeContinuityCaptureWireless, "continuity"),
            (0, "unknown"),
        ]
        for (t, name) in cases { #expect(Devices.transportName(t) == name, "transport \(t)") }
    }

    @Test func fourCCPacksFourCharacters() {
        #expect(Devices.fourCC("hdpn") == 0x6864_706E)
        #expect(Devices.fourCC("ispk") == 0x6973_706B)
    }

    @Test func addressDefaultsToTheGlobalScopeAndMainElement() {
        let a = Devices.address(kAudioHardwarePropertyDevices)
        #expect(a.mSelector == kAudioHardwarePropertyDevices)
        #expect(a.mScope == kAudioObjectPropertyScopeGlobal)
        #expect(a.mElement == kAudioObjectPropertyElementMain)
        #expect(Devices.address(kAudioDevicePropertyDataSource, kAudioObjectPropertyScopeOutput).mScope == kAudioObjectPropertyScopeOutput)
    }

    @Test func listingIncludesTheChannelCount() {
        let d = Devices.Input(id: 1, uid: "bh", name: "BlackHole 2ch", transport: "virtual", isDefault: false, channels: 2)
        let j = Devices.listing(d)
        #expect(j["channels"] as? Int == 2)
        #expect(j["uid"] as? String == "bh")
    }

    @Test func deskRefusalNamesADeviceThatHasFewerChannelsThanAsked() {
        #expect(Devices.deskRefusal(channels: 1, needed: 2, name: "MacBook Pro Microphone") == "desk capture needs 2 input channels, MacBook Pro Microphone has 1")
        #expect(Devices.deskRefusal(channels: 3, needed: 4, name: "Desk 4ch") == "desk capture needs 4 input channels, Desk 4ch has 3")
        #expect(Devices.deskRefusal(channels: 4, needed: 4, name: "Desk 4ch") == nil)
        #expect(Devices.deskRefusal(channels: 16, needed: 2, name: "BlackHole 16ch") == nil)
    }
}
