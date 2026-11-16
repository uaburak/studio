import Foundation
import Testing
@testable import Studio

@Suite("Schedule time: device time zone → UTC")
struct ScheduleTimeTests {
    private func wall(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int) -> DateComponents {
        DateComponents(year: y, month: m, day: d, hour: h, minute: min)
    }

    @Test func istanbulIsUTCPlusThree() throws {
        let tz = try #require(TimeZone(identifier: "Europe/Istanbul"))
        let date = try #require(ScheduleTime.instant(wall(2026, 11, 20, 10, 0), in: tz))
        #expect(ScheduleTime.utcString(date) == "2026-11-20T07:00:00.000Z")
    }

    @Test func newYorkWinterAndSummer() throws {
        let tz = try #require(TimeZone(identifier: "America/New_York"))
        let winter = try #require(ScheduleTime.instant(wall(2026, 1, 15, 9, 30), in: tz))
        #expect(ScheduleTime.utcString(winter) == "2026-01-15T14:30:00.000Z")
        let summer = try #require(ScheduleTime.instant(wall(2026, 7, 15, 9, 30), in: tz))
        #expect(ScheduleTime.utcString(summer) == "2026-07-15T13:30:00.000Z")
    }

    @Test func dateChangesAcrossMidnight() throws {
        let tz = try #require(TimeZone(identifier: "Europe/Istanbul"))
        let date = try #require(ScheduleTime.instant(wall(2026, 12, 1, 1, 15), in: tz))
        #expect(ScheduleTime.utcString(date) == "2026-11-30T22:15:00.000Z")
    }

    /// 2026-03-08 02:30 does not exist in New York (clocks jump 02:00 → 03:00).
    @Test func skippedLocalTimeMovesForward() throws {
        let tz = try #require(TimeZone(identifier: "America/New_York"))
        let date = try #require(ScheduleTime.instant(wall(2026, 3, 8, 2, 30), in: tz))
        #expect(ScheduleTime.utcString(date) == "2026-03-08T07:30:00.000Z") // 03:30 EDT
    }

    /// 2026-11-01 01:30 happens twice in New York; the first (EDT) is used.
    @Test func repeatedLocalTimeUsesTheFirstOccurrence() throws {
        let tz = try #require(TimeZone(identifier: "America/New_York"))
        let date = try #require(ScheduleTime.instant(wall(2026, 11, 1, 1, 30), in: tz))
        #expect(ScheduleTime.utcString(date) == "2026-11-01T05:30:00.000Z")
    }

    @Test func wallClockRoundTrip() throws {
        let tz = try #require(TimeZone(identifier: "Asia/Kolkata"))
        let date = try #require(ScheduleTime.instant(wall(2026, 6, 1, 18, 45), in: tz))
        let parts = ScheduleTime.wallClock(date, in: tz)
        #expect([parts.year, parts.month, parts.day, parts.hour, parts.minute] == [2026, 6, 1, 18, 45])
        #expect(ScheduleTime.utcString(date) == "2026-06-01T13:15:00.000Z")
    }

    @Test func validation() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        #expect(ScheduleTime.validate(now.addingTimeInterval(-60), now: now) == .inPast)
        #expect(ScheduleTime.validate(now, now: now) == .inPast)
        #expect(ScheduleTime.validate(now.addingTimeInterval(60), now: now) == .tooSoon)
        #expect(ScheduleTime.validate(now.addingTimeInterval(180), now: now) == nil)
    }

    @Test func truncatesSeconds() {
        let date = Date(timeIntervalSince1970: 1_800_000_059.9)
        #expect(ScheduleTime.truncatedToMinute(date).timeIntervalSince1970 == 1_800_000_000)
    }

    @Test func zoneDescription() throws {
        let istanbul = try #require(TimeZone(identifier: "Europe/Istanbul"))
        #expect(ScheduleTime.zoneDescription(istanbul) == "GMT+3 · Europe/Istanbul")
        let kolkata = try #require(TimeZone(identifier: "Asia/Kolkata"))
        #expect(ScheduleTime.zoneDescription(kolkata) == "GMT+5:30 · Asia/Kolkata")
    }

    @Test func groupsSchedulesByLocalDay() throws {
        let tz = try #require(TimeZone(identifier: "Europe/Istanbul"))
        var base = try Fixture.decode(Schedule.self, "schedule")
        // 22:30Z on the 19th is 01:30 on the 20th in Istanbul.
        base.scheduledAt = try #require(Timestamp.parse("2026-11-19T22:30:00Z"))
        var second = base
        second.id = "s2"
        second.scheduledAt = try #require(Timestamp.parse("2026-11-20T08:00:00Z"))
        var third = base
        third.id = "s3"
        third.scheduledAt = try #require(Timestamp.parse("2026-11-19T20:00:00Z"))
        let groups = ScheduleListModel.groupByDay([second, base, third], timeZone: tz)
        #expect(groups.map { $0.items.map(\.id) } == [["s3"], [base.id, "s2"]])
    }
}
