import Foundation

// A small, streaming-tolerant Markdown parser for the agent's replies (Claude Code's
// transcript): headings, run-in bold headings, nested bullet / numbered lists, fenced
// code, tables, block quotes, rules and the usual inline spans. Unclosed constructs at the
// end of a still-streaming reply render as plain text (or, for a code fence, as code).

/// Inline span.
indirect enum MarkdownInline: Equatable, Sendable {
    case text(String)
    case strong([MarkdownInline])
    case emphasis([MarkdownInline])
    case strikethrough([MarkdownInline])
    case code(String)
    case link([MarkdownInline], url: String)
    /// A line break inside one paragraph.
    case lineBreak
}

struct MarkdownListItem: Equatable, Sendable {
    /// Nesting level, 0 = outermost.
    var depth: Int
    /// The number shown for an ordered item (already renumbered), nil for a bullet.
    var ordinal: Int?
    var content: [MarkdownInline]
}

struct MarkdownTable: Equatable, Sendable {
    enum Alignment: Equatable, Sendable { case leading, center, trailing }
    var header: [[MarkdownInline]]
    var alignments: [Alignment]
    /// Every row has `header.count` cells.
    var rows: [[[MarkdownInline]]]
}

indirect enum MarkdownBlock: Equatable, Sendable {
    case paragraph([MarkdownInline])
    case heading(level: Int, [MarkdownInline])
    /// A paragraph that is only bold text (`**Plan:**`): a run-in section heading.
    case boldHeading([MarkdownInline])
    case list([MarkdownListItem])
    case code(language: String?, code: String)
    case table(MarkdownTable)
    case quote([MarkdownBlock])
    case rule
}

enum Markdown {
    // MARK: Blocks

    static func parse(_ source: String) -> [MarkdownBlock] {
        let normalized = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\t", with: "    ")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        return parseLines(lines)
    }

    private static func parseLines(_ lines: [String]) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0

        /// A line that is only bold text is a run-in heading even inside a paragraph
        /// ("**Plan:**" followed by text on the next line).
        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            var run: [String] = []
            func flushRun() {
                guard !run.isEmpty else { return }
                blocks.append(.paragraph(parseInlines(run.joined(separator: "\n"))))
                run = []
            }
            for line in paragraph {
                let inlines = parseInlines(line)
                if isBoldHeading(inlines) {
                    flushRun()
                    blocks.append(.boldHeading(inlines))
                } else {
                    run.append(line)
                }
            }
            flushRun()
            paragraph = []
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }
            if let fence = fenceOpening(line) {
                flushParagraph()
                var code: [String] = []
                i += 1
                while i < lines.count {
                    if isFenceClosing(lines[i], fence: fence) {
                        i += 1
                        break
                    }
                    code.append(stripIndent(lines[i], upTo: fence.indent))
                    i += 1
                }
                blocks.append(.code(language: fence.language, code: code.joined(separator: "\n")))
                continue
            }
            if let heading = headingLine(trimmed) {
                flushParagraph()
                blocks.append(.heading(level: heading.level, parseInlines(heading.text)))
                i += 1
                continue
            }
            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }
            if trimmed.hasPrefix(">") {
                flushParagraph()
                var inner: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    var rest = t.dropFirst()
                    if rest.hasPrefix(" ") { rest = rest.dropFirst() }
                    inner.append(String(rest))
                    i += 1
                }
                blocks.append(.quote(parseLines(inner)))
                continue
            }
            if line.contains("|"), i + 1 < lines.count, let alignments = tableDelimiter(lines[i + 1]) {
                let header = splitRow(line)
                if header.count == alignments.count || header.count > 1 {
                    flushParagraph()
                    let columns = header.count
                    var rows: [[[MarkdownInline]]] = []
                    i += 2
                    while i < lines.count {
                        let t = lines[i].trimmingCharacters(in: .whitespaces)
                        guard !t.isEmpty, t.contains("|") else { break }
                        var cells = splitRow(lines[i])
                        if cells.count < columns { cells += Array(repeating: "", count: columns - cells.count) }
                        rows.append(cells.prefix(columns).map(parseInlines))
                        i += 1
                    }
                    var aligns = alignments
                    if aligns.count < columns { aligns += Array(repeating: .leading, count: columns - aligns.count) }
                    blocks.append(.table(MarkdownTable(header: header.map(parseInlines), alignments: Array(aligns.prefix(columns)), rows: rows)))
                    continue
                }
            }
            if listMarker(line) != nil {
                flushParagraph()
                let (items, next) = parseList(lines, from: i)
                blocks.append(.list(items))
                i = next
                continue
            }
            paragraph.append(trimmed)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    // MARK: Lists

    struct ListMarker: Equatable {
        var indent: Int
        var ordinal: Int?
        var content: String
    }

    static func listMarker(_ line: String) -> ListMarker? {
        let chars = Array(line)
        var index = 0
        while index < chars.count, chars[index] == " " { index += 1 }
        let indent = index
        guard index < chars.count else { return nil }
        var ordinal: Int?
        if "-*+".contains(chars[index]) {
            index += 1
        } else if chars[index].isASCII, chars[index].isNumber {
            var digits = ""
            while index < chars.count, chars[index].isASCII, chars[index].isNumber, digits.count < 9 {
                digits.append(chars[index])
                index += 1
            }
            guard index < chars.count, chars[index] == "." || chars[index] == ")" else { return nil }
            ordinal = Int(digits)
            index += 1
        } else {
            return nil
        }
        // The marker needs a space after it (or ends the line while streaming).
        if index < chars.count {
            guard chars[index] == " " else { return nil }
        } else if ordinal == nil {
            return nil
        }
        while index < chars.count, chars[index] == " " { index += 1 }
        return ListMarker(indent: indent, ordinal: ordinal, content: String(chars[index...]))
    }

    private static func parseList(_ lines: [String], from start: Int) -> ([MarkdownListItem], Int) {
        struct RawItem { var depth: Int; var ordinal: Int?; var text: String }
        var raw: [RawItem] = []
        var indents: [Int] = []
        var i = start
        while i < lines.count {
            let line = lines[i]
            if let marker = listMarker(line), !isRule(line.trimmingCharacters(in: .whitespaces)) {
                while let last = indents.last, marker.indent < last { indents.removeLast() }
                if let last = indents.last {
                    if marker.indent >= last + 2 { indents.append(marker.indent) }
                } else {
                    indents.append(marker.indent)
                }
                raw.append(RawItem(depth: min(indents.count - 1, 5), ordinal: marker.ordinal, text: marker.content))
                i += 1
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                var j = i + 1
                while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).isEmpty { j += 1 }
                guard j < lines.count else { break }
                if listMarker(lines[j]) != nil {
                    i = j
                    continue
                }
                if leadingSpaces(lines[j]) >= 2, !raw.isEmpty {
                    raw[raw.count - 1].text += "\n" + lines[j].trimmingCharacters(in: .whitespaces)
                    i = j + 1
                    continue
                }
                break
            }
            guard !raw.isEmpty, !startsBlock(line) else { break }
            raw[raw.count - 1].text += "\n" + trimmed
            i += 1
        }

        // Ordered items count up from the first number of each run (agents often write `1.` for all).
        var counters: [Int: Int] = [:]
        var items: [MarkdownListItem] = []
        for item in raw {
            for key in counters.keys where key > item.depth { counters[key] = nil }
            var ordinal: Int?
            if let given = item.ordinal {
                let next = counters[item.depth].map { $0 + 1 } ?? given
                counters[item.depth] = next
                ordinal = next
            } else {
                counters[item.depth] = nil
            }
            items.append(MarkdownListItem(depth: item.depth, ordinal: ordinal, content: parseInlines(item.text)))
        }
        return (items, i)
    }

    private static func leadingSpaces(_ line: String) -> Int {
        line.prefix { $0 == " " }.count
    }

    /// Lines that end a list's lazy continuation.
    private static func startsBlock(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        return fenceOpening(line) != nil || headingLine(trimmed) != nil || isRule(trimmed) || trimmed.hasPrefix(">")
    }

    // MARK: Fences, headings, rules, tables

    struct Fence: Equatable {
        var marker: Character
        var length: Int
        var indent: Int
        var language: String?
    }

    static func fenceOpening(_ line: String) -> Fence? {
        let indent = leadingSpaces(line)
        guard indent <= 3 else { return nil }
        let rest = line.dropFirst(indent)
        guard let first = rest.first, first == "`" || first == "~" else { return nil }
        let run = rest.prefix { $0 == first }
        guard run.count >= 3 else { return nil }
        let info = rest.dropFirst(run.count).trimmingCharacters(in: .whitespaces)
        if first == "`", info.contains("`") { return nil }
        let language = info.split(separator: " ").first.map(String.init)
        return Fence(marker: first, length: run.count, indent: indent, language: language?.isEmpty == false ? language : nil)
    }

    private static func isFenceClosing(_ line: String, fence: Fence) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.count >= fence.length, trimmed.allSatisfy({ $0 == fence.marker }) else { return false }
        return leadingSpaces(line) <= 3
    }

    private static func stripIndent(_ line: String, upTo count: Int) -> String {
        var removed = 0
        var index = line.startIndex
        while removed < count, index < line.endIndex, line[index] == " " {
            index = line.index(after: index)
            removed += 1
        }
        return String(line[index...])
    }

    static func headingLine(_ trimmed: String) -> (level: Int, text: String)? {
        let hashes = trimmed.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // Optional closing sequence: `## Title ##`.
        if let range = text.range(of: #"\s+#+$"#, options: .regularExpression) { text.removeSubrange(range) }
        return (hashes, text)
    }

    static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { $0 != " " }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    /// The alignments of a `| --- | :-: |` row, nil when the line is not one.
    static func tableDelimiter(_ line: String) -> [MarkdownTable.Alignment]? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-"), trimmed.contains("|") || trimmed.hasPrefix(":") || trimmed.hasPrefix("-") else { return nil }
        let cells = splitRow(line)
        guard !cells.isEmpty else { return nil }
        var alignments: [MarkdownTable.Alignment] = []
        for cell in cells {
            let c = cell.trimmingCharacters(in: .whitespaces)
            let core = c.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard !core.isEmpty, core.allSatisfy({ $0 == "-" }) else { return nil }
            let left = c.hasPrefix(":"), right = c.hasSuffix(":")
            alignments.append(left && right ? .center : right ? .trailing : .leading)
        }
        // A lone `---` is a rule, not a one-column table.
        if cells.count == 1, !trimmed.contains("|") { return nil }
        return alignments
    }

    /// Cells of a table row: outer pipes dropped, `\|` and pipes inside `code` kept.
    static func splitRow(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|"), !text.hasSuffix("\\|") { text.removeLast() }
        var cells: [String] = []
        var current = ""
        var inCode = false
        var previous: Character?
        for ch in text {
            if ch == "`" { inCode.toggle() }
            if ch == "|", !inCode, previous != "\\" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else if ch == "|", previous == "\\" {
                current.removeLast()
                current.append(ch)
            } else {
                current.append(ch)
            }
            previous = ch
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    /// A one-line paragraph that is only bold text, optionally followed by `:`.
    private static func isBoldHeading(_ inlines: [MarkdownInline]) -> Bool {
        guard case .strong = inlines.first else { return false }
        for inline in inlines.dropFirst() {
            guard case .text(let text) = inline, text.trimmingCharacters(in: .whitespaces).allSatisfy({ $0 == ":" }) else { return false }
        }
        return true
    }

    // MARK: Inlines

    static func parseInlines(_ text: String) -> [MarkdownInline] {
        var parser = InlineParser(chars: Array(text))
        return parser.parse()
    }

    /// The visible text of inline spans (copy, accessibility, tests).
    static func plainText(_ inlines: [MarkdownInline]) -> String {
        inlines.map { inline -> String in
            switch inline {
            case .text(let text), .code(let text): text
            case .strong(let children), .emphasis(let children), .strikethrough(let children): plainText(children)
            case .link(let children, _): plainText(children)
            case .lineBreak: "\n"
            }
        }.joined()
    }
}

private struct InlineParser {
    let chars: [Character]

    mutating func parse() -> [MarkdownInline] {
        parse(range: 0..<chars.count)
    }

    private func parse(range: Range<Int>) -> [MarkdownInline] {
        var result: [MarkdownInline] = []
        var buffer = ""
        var i = range.lowerBound
        let end = range.upperBound

        func flush() {
            if !buffer.isEmpty {
                if case .text(let previous)? = result.last {
                    result[result.count - 1] = .text(previous + buffer)
                } else {
                    result.append(.text(buffer))
                }
                buffer = ""
            }
        }

        while i < end {
            let ch = chars[i]
            // Escapes.
            if ch == "\\", i + 1 < end, chars[i + 1].isPunctuation || chars[i + 1].isSymbol {
                buffer.append(chars[i + 1])
                i += 2
                continue
            }
            if ch == "\n" {
                flush()
                result.append(.lineBreak)
                i += 1
                continue
            }
            if ch == "`" {
                let run = runLength(of: "`", at: i, end: end)
                if let close = findBacktickRun(length: run, from: i + run, end: end) {
                    var code = String(chars[(i + run)..<close])
                    if code.count >= 2, code.hasPrefix(" "), code.hasSuffix(" "), code.trimmingCharacters(in: .whitespaces).count > 0 {
                        code = String(code.dropFirst().dropLast())
                    }
                    flush()
                    result.append(.code(code))
                    i = close + run
                    continue
                }
                buffer.append(String(repeating: "`", count: run))
                i += run
                continue
            }
            if (ch == "*" || ch == "_"), i + 1 < end, chars[i + 1] == ch, canOpen(at: i, width: 2, end: end, marker: ch) {
                if let close = findClosing(marker: ch, width: 2, from: i + 2, end: end) {
                    flush()
                    result.append(.strong(parse(range: (i + 2)..<close)))
                    i = close + 2
                    continue
                }
            }
            if ch == "~", i + 1 < end, chars[i + 1] == "~", canOpen(at: i, width: 2, end: end, marker: ch) {
                if let close = findClosing(marker: ch, width: 2, from: i + 2, end: end) {
                    flush()
                    result.append(.strikethrough(parse(range: (i + 2)..<close)))
                    i = close + 2
                    continue
                }
            }
            if (ch == "*" || ch == "_"), canOpen(at: i, width: 1, end: end, marker: ch) {
                if let close = findClosing(marker: ch, width: 1, from: i + 1, end: end) {
                    flush()
                    result.append(.emphasis(parse(range: (i + 1)..<close)))
                    i = close + 1
                    continue
                }
            }
            if ch == "[", let link = parseLink(at: i, end: end) {
                flush()
                result.append(.link(parse(range: link.label), url: link.url))
                i = link.next
                continue
            }
            if ch == "<", let auto = parseAutolink(at: i, end: end) {
                flush()
                result.append(.link([.text(auto.url)], url: auto.url))
                i = auto.next
                continue
            }
            if ch == "h", let bare = parseBareURL(at: i, end: end) {
                flush()
                result.append(.link([.text(bare.url)], url: bare.url))
                i = bare.next
                continue
            }
            buffer.append(ch)
            i += 1
        }
        flush()
        return result
    }

    private func runLength(of marker: Character, at index: Int, end: Int) -> Int {
        var n = 0
        while index + n < end, chars[index + n] == marker { n += 1 }
        return n
    }

    private func findBacktickRun(length: Int, from start: Int, end: Int) -> Int? {
        var j = start
        while j < end {
            if chars[j] == "`" {
                let run = runLength(of: "`", at: j, end: end)
                if run == length { return j }
                j += run
            } else {
                j += 1
            }
        }
        return nil
    }

    /// An opening delimiter is followed by a non-space; `_` also must not sit inside a word.
    private func canOpen(at index: Int, width: Int, end: Int, marker: Character) -> Bool {
        guard index + width < end, !chars[index + width].isWhitespace else { return false }
        if marker == "_", index > 0, chars[index - 1].isLetter || chars[index - 1].isNumber { return false }
        return true
    }

    /// The matching closing delimiter (preceded by a non-space), skipping code spans.
    private func findClosing(marker: Character, width: Int, from start: Int, end: Int) -> Int? {
        var j = start
        while j < end {
            let ch = chars[j]
            if ch == "\\" {
                j += 2
                continue
            }
            if ch == "`" {
                let run = runLength(of: "`", at: j, end: end)
                if let close = findBacktickRun(length: run, from: j + run, end: end) {
                    j = close + run
                    continue
                }
                j += run
                continue
            }
            if ch == marker {
                let run = runLength(of: marker, at: j, end: end)
                if width == 1 {
                    // A `**` pair inside emphasis belongs to nested strong text.
                    if run == 1, j > start, !chars[j - 1].isWhitespace, closesWord(after: j + 1, end: end, marker: marker) {
                        return j
                    }
                    if run >= 2, let inner = findClosing(marker: marker, width: 2, from: j + 2, end: end) {
                        j = inner + 2
                        continue
                    }
                } else if run >= width, j > start, !chars[j - 1].isWhitespace, closesWord(after: j + width, end: end, marker: marker) {
                    // `***x***`: close at the last pair of the run.
                    return j + (run - width)
                }
                j += run
                continue
            }
            j += 1
        }
        return nil
    }

    private func closesWord(after index: Int, end: Int, marker: Character) -> Bool {
        guard marker == "_", index < end else { return true }
        return !(chars[index].isLetter || chars[index].isNumber)
    }

    private func parseLink(at index: Int, end: Int) -> (label: Range<Int>, url: String, next: Int)? {
        var depth = 0
        var j = index
        var closeBracket: Int?
        while j < end {
            if chars[j] == "\\" { j += 2; continue }
            if chars[j] == "[" { depth += 1 }
            if chars[j] == "]" {
                depth -= 1
                if depth == 0 { closeBracket = j; break }
            }
            j += 1
        }
        guard let close = closeBracket, close + 1 < end, chars[close + 1] == "(" else { return nil }
        var k = close + 2
        var parens = 1
        var url = ""
        while k < end {
            let c = chars[k]
            if c == "(" { parens += 1 }
            if c == ")" {
                parens -= 1
                if parens == 0 { break }
            }
            url.append(c)
            k += 1
        }
        guard k < end, parens == 0 else { return nil }
        var target = url.trimmingCharacters(in: .whitespaces)
        // `[x](url "title")`: drop the title.
        if let space = target.firstIndex(of: " ") { target = String(target[..<space]) }
        if target.hasPrefix("<"), target.hasSuffix(">") { target = String(target.dropFirst().dropLast()) }
        guard !target.isEmpty else { return nil }
        return ((index + 1)..<close, target, k + 1)
    }

    private func parseAutolink(at index: Int, end: Int) -> (url: String, next: Int)? {
        var j = index + 1
        var url = ""
        while j < end, chars[j] != ">" {
            if chars[j].isWhitespace || chars[j] == "<" { return nil }
            url.append(chars[j])
            j += 1
        }
        guard j < end, url.hasPrefix("http://") || url.hasPrefix("https://") || url.hasPrefix("mailto:") else { return nil }
        return (url, j + 1)
    }

    private func parseBareURL(at index: Int, end: Int) -> (url: String, next: Int)? {
        if index > 0, chars[index - 1].isLetter || chars[index - 1].isNumber { return nil }
        let prefixes = ["https://", "http://"]
        let lookahead = String(chars[index..<min(end, index + 8)])
        guard prefixes.contains(where: { lookahead.hasPrefix($0) }) else { return nil }
        var j = index
        var url = ""
        while j < end, !chars[j].isWhitespace, chars[j] != "<", chars[j] != ">" {
            url.append(chars[j])
            j += 1
        }
        // Trailing punctuation belongs to the sentence.
        while let last = url.last, ".,;:!?)]'\"".contains(last) {
            if last == ")", url.filter({ $0 == "(" }).count >= url.filter({ $0 == ")" }).count { break }
            url.removeLast()
            j -= 1
        }
        guard url.count > 8 else { return nil }
        return (url, j)
    }
}
