import XCTest

/// Launches the app against the in-app stub backend (`-StudioUITest`, Debug
/// builds only): no server, no network.
@MainActor
final class MainFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-StudioUITest"]
        app.launch()
        return app
    }

    func testHomeShowsBrandAndMacOffline() {
        let app = launch()
        XCTAssertTrue(app.buttons["brandSwitcher"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Mac çevrimdışı"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Hasat sezonu"].waitForExistence(timeout: 10))
    }

    func testComposeQueuesAJob() {
        let app = launch()
        app.tabBars.buttons["Yeni"].tap()
        let brief = app.textViews["briefField"].exists ? app.textViews["briefField"] : app.textFields["briefField"]
        XCTAssertTrue(brief.waitForExistence(timeout: 10))
        brief.tap()
        brief.typeText("Kış kampanyası için tek görsellik post")
        let submit = app.buttons["submitButton"]
        if !submit.isHittable { app.swipeUp() }
        submit.tap()
        XCTAssertTrue(app.staticTexts["Kuyruğa eklendi"].waitForExistence(timeout: 10))

        app.tabBars.buttons["İşler"].tap()
        XCTAssertTrue(app.staticTexts["Kış kampanyası için tek görsellik post"].waitForExistence(timeout: 10))
    }

    func testReviewShowsSlidesAndApproves() {
        let app = launch()
        app.tabBars.buttons["İnceleme"].tap()
        let row = app.buttons.matching(identifier: "contentRow").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
        XCTAssertTrue(app.otherElements["slideCarousel"].waitForExistence(timeout: 10)
                      || app.collectionViews["slideCarousel"].waitForExistence(timeout: 2))
        let approve = app.buttons["approveButton"]
        XCTAssertTrue(approve.waitForExistence(timeout: 10))
        approve.tap()
        let confirm = app.buttons["confirmApprove"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        XCTAssertTrue(app.buttons["scheduleButton"].waitForExistence(timeout: 10))
    }
}
