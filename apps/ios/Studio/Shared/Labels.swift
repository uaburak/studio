import SwiftUI

// Turkish labels and colours for contract enums.

extension Platform {
    var label: String {
        switch self {
        case .instagram: "Instagram"
        case .facebook: "Facebook"
        case .linkedin: "LinkedIn"
        case .unknown: "Diğer"
        }
    }

    var shortLabel: String {
        switch self {
        case .instagram: "IG"
        case .facebook: "FB"
        case .linkedin: "in"
        case .unknown: "?"
        }
    }
}

extension ContentType {
    var label: String {
        switch self {
        case .post: "Post"
        case .carousel: "Carousel"
        case .story: "Story"
        case .reel: "Reels"
        case .unknown: "Diğer"
        }
    }

    var symbol: String {
        switch self {
        case .post: "square"
        case .carousel: "square.stack"
        case .story: "rectangle.portrait"
        case .reel: "play.rectangle"
        case .unknown: "questionmark.square"
        }
    }
}

extension ContentStatus {
    var label: String {
        switch self {
        case .draft: "Taslak"
        case .inReview: "İncelemede"
        case .approved: "Onaylandı"
        case .scheduled: "Zamanlandı"
        case .publishing: "Yayınlanıyor"
        case .published: "Yayınlandı"
        case .failed: "Hata"
        case .unknown: "Bilinmiyor"
        }
    }

    var tint: Color {
        switch self {
        case .draft: .gray
        case .inReview: .orange
        case .approved: .green
        case .scheduled: .blue
        case .publishing: .indigo
        case .published: .teal
        case .failed: .red
        case .unknown: .gray
        }
    }
}

extension ContentVersionOrigin {
    var label: String {
        switch self {
        case .generated: "Üretildi"
        case .manualEdit: "Elle düzenlendi"
        case .aiEdit: "AI ile düzenlendi"
        case .unknown: "Bilinmiyor"
        }
    }
}

extension JobType {
    var label: String {
        switch self {
        case .contentGenerate: "İçerik üretimi"
        case .contentRender: "Render"
        case .brandAnalyze: "Marka analizi"
        case .demoEcho: "Deneme işi"
        case .unknown: "İş"
        }
    }
}

extension JobStatus {
    var label: String {
        switch self {
        case .queued: "Sırada"
        case .running: "Çalışıyor"
        case .succeeded: "Tamamlandı"
        case .failed: "Başarısız"
        case .cancelled: "İptal edildi"
        case .unknown: "Bilinmiyor"
        }
    }

    var tint: Color {
        switch self {
        case .queued: .orange
        case .running: .blue
        case .succeeded: .green
        case .failed: .red
        case .cancelled, .unknown: .gray
        }
    }

    var symbol: String {
        switch self {
        case .queued: "clock"
        case .running: "gearshape.2"
        case .succeeded: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .cancelled: "xmark.circle"
        case .unknown: "questionmark.circle"
        }
    }
}

extension ScheduleStatus {
    var label: String {
        switch self {
        case .pending: "Bekliyor"
        case .publishing: "Yayınlanıyor"
        case .published: "Yayınlandı"
        case .failed: "Hata"
        case .cancelled: "İptal edildi"
        case .unknown: "Bilinmiyor"
        }
    }

    var tint: Color {
        switch self {
        case .pending: .blue
        case .publishing: .indigo
        case .published: .green
        case .failed: .red
        case .cancelled, .unknown: .gray
        }
    }
}

extension SocialAccountStatus {
    var label: String {
        switch self {
        case .pending: "Bağlanmadı"
        case .connected: "Bağlı"
        case .needsReauth: "Yeniden yetki gerekli"
        case .disabled: "Devre dışı"
        case .unknown: "Bilinmiyor"
        }
    }
}

extension Job {
    /// What the job is about, for list rows ("Hasat sezonu").
    var displayTitle: String {
        if let title = payload["title"]?.stringValue, !title.isEmpty { return title }
        if let brief = payload["brief"]?.stringValue, !brief.isEmpty { return String(brief.prefix(80)) }
        return type.label
    }
}
