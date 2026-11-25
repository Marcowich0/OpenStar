//! Song media through the real app over HTTP, with tiny media made by the
//! real ffmpeg at test time: probing with ffprobe, native playability by
//! codecs, one file or two for audio and video, the cover and background
//! fallback rules, the generated tile, length and has video, and the media
//! URLs served with `Range` requests.
//!
//! Images are written as a few placeholder bytes: the scan tells images by
//! their extension and never decodes them.

use std::path::Path;
use std::time::Duration;

use openstar_protocol::library::{
    MediaFile, ScanReport, ScanStatus, SongArtwork, SongDetail, SongSummary, SongVideo,
};
use openstar_test_harness::{AppFolders, Media, TestApp};

const BODY: &str = ": 0 4 0 La\nE\n";

fn write_txt(folder: &Path, headers: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(
        folder.join("song.txt"),
        format!("{headers}#BPM:200\n{BODY}"),
    )
    .unwrap();
}

fn image(folder: &Path, name: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::write(folder.join(name), b"placeholder image").unwrap();
}

fn copy(from: &Path, folder: &Path, name: &str) {
    std::fs::create_dir_all(folder).unwrap();
    std::fs::copy(from, folder.join(name)).unwrap();
}

async fn scanned(app: &TestApp, finished: u32) -> ScanReport {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let status: ScanStatus = app.get_json("/api/library/scan").await;
        if !status.running && status.finished >= finished {
            return status.last.expect("a finished scan has a report");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "scan {finished} did not finish"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn rescan(app: &TestApp, finished: u32) -> ScanReport {
    let response = app
        .http()
        .post(app.url("/api/library/rescan"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    scanned(app, finished).await
}

async fn summary(app: &TestApp, folder: &str) -> SongSummary {
    let songs: Vec<SongSummary> = app.get_json("/api/songs").await;
    let path = format!("{folder}/song.txt");
    songs
        .into_iter()
        .find(|s| s.path == path)
        .unwrap_or_else(|| panic!("{path} is not in the Song list"))
}

async fn detail(app: &TestApp, folder: &str) -> SongDetail {
    let id = summary(app, folder).await.id;
    app.get_json(&format!("/api/songs/{}", id.0)).await
}

fn url(id: u32, role: &str) -> String {
    format!("/api/songs/{id}/media/{role}")
}

fn image_at(id: u32, role: &str) -> SongArtwork {
    SongArtwork::Image { url: url(id, role) }
}

/// A Library with one Song per case, its media made by the real ffmpeg.
fn library(media: &Media) -> AppFolders {
    let folders = AppFolders::new();
    let songs = folders.songs_dir();
    let mp4 = media.tiny_video("clip.mp4", 1.0).unwrap();
    let avi = media.tiny_video("clip.avi", 1.0).unwrap();
    let ogg = media.tone("tone.ogg", 440.0, 2.0, 44_100).unwrap();

    // One H.264/AAC MP4 as audio and video; the cover is the `[CO]` image.
    let one = songs.join("One File");
    copy(&mp4, &one, "clip.mp4");
    write_txt(
        &one,
        "#ARTIST:A\n#TITLE:One\n#MP3:clip.mp4\n#VIDEO:CLIP.mp4\n#VIDEOGAP:2.5\n",
    );
    image(&one, "One [CO].jpg");
    image(&one, "One [BG].jpg");
    image(&one, "cover.png");

    // Ogg audio, an MPEG-4 Part 2 AVI video, `#COVER` in other case,
    // `#BACKGROUND`, and `#END`.
    let two = songs.join("Two Files");
    copy(&ogg, &two, "tone.ogg");
    copy(&avi, &two, "clip.avi");
    write_txt(
        &two,
        "#ARTIST:A\n#TITLE:Two\n#MP3:tone.ogg\n#VIDEO:clip.avi\n#VIDEOGAP:1,5\n\
         #COVER:front.PNG\n#BACKGROUND:back.webp\n#END:90500\n",
    );
    image(&two, "Front.png");
    image(&two, "back.webp");
    image(&two, "x [CO].jpg");

    // `cover.*` wins over other images; no `#BACKGROUND`: the cover.
    let named = songs.join("Named Cover");
    copy(&ogg, &named, "tone.ogg");
    write_txt(&named, "#ARTIST:A\n#TITLE:Named\n#MP3:tone.ogg\n");
    image(&named, "Cover.JPEG");
    image(&named, "photo.jpg");

    // The only image is the cover. A `#COVER` that is not found falls through.
    let only = songs.join("Only Image");
    copy(&ogg, &only, "tone.ogg");
    write_txt(
        &only,
        "#ARTIST:A\n#TITLE:Only\n#MP3:tone.ogg\n#COVER:missing.jpg\n",
    );
    image(&only, "whatever.webp");
    std::fs::write(only.join("notes.gif"), b"not a Stage image").unwrap();

    // Two images and no rule matches: no cover, the generated tile.
    let tile = songs.join("Tile");
    copy(&ogg, &tile, "tone.ogg");
    write_txt(&tile, "#ARTIST:A\n#TITLE:Tile\n#MP3:tone.ogg\n");
    image(&tile, "a.jpg");
    image(&tile, "b.jpg");
    folders
}

#[tokio::test]
async fn probes_media_and_finds_covers_and_backgrounds() {
    let media = Media::new();
    let mut app = TestApp::builder().folders(library(&media)).start().await;
    let report = scanned(&app, 1).await;
    assert_eq!(report.probed, 6, "clip.mp4, tone.ogg ×4, clip.avi");

    // One file as both: native, #VIDEOGAP ignored, the `[CO]` cover.
    let one = detail(&app, "One File").await;
    let id = one.id.0;
    assert_eq!(
        one.media.audio,
        MediaFile {
            url: url(id, "audio"),
            native: true
        }
    );
    assert_eq!(one.media.video, Some(SongVideo::InAudio));
    assert_eq!(one.media.cover, image_at(id, "cover"));
    assert_eq!(one.media.background, image_at(id, "background"));
    let length = one.length_seconds.expect("probed");
    assert!((0.9..1.2).contains(&length), "{length}");
    let listed = summary(&app, "One File").await;
    assert!(listed.has_video);
    assert_eq!(listed.cover, image_at(id, "cover"));
    assert_eq!(fetch(&app, &url(id, "cover")).await, b"placeholder image");

    // Two files: the AVI needs conversion; gap in seconds; `#END` is the length.
    let two = detail(&app, "Two Files").await;
    let id = two.id.0;
    assert_eq!(
        two.media.audio,
        MediaFile {
            url: url(id, "audio"),
            native: true
        }
    );
    assert_eq!(
        two.media.video,
        Some(SongVideo::File {
            file: MediaFile {
                url: url(id, "video"),
                native: false
            },
            gap_seconds: 1.5,
        })
    );
    assert_eq!(two.length_seconds, Some(90.5));
    assert!(summary(&app, "Two Files").await.has_video);
    assert_eq!(two.media.cover, image_at(id, "cover"));
    let songs = app.songs_dir().to_owned();
    assert_eq!(
        fetch(&app, &url(id, "video")).await,
        std::fs::read(songs.join("Two Files/clip.avi")).unwrap()
    );

    // Each cover rule picks the expected image.
    for (folder, cover, background) in [
        ("One File", "One [CO].jpg", "One [CO].jpg"),
        ("Two Files", "Front.png", "back.webp"),
        ("Named Cover", "Cover.JPEG", "Cover.JPEG"),
        ("Only Image", "whatever.webp", "whatever.webp"),
    ] {
        let song = detail(&app, folder).await;
        assert_eq!(song.media.cover, image_at(song.id.0, "cover"), "{folder}");
        assert_eq!(
            fetch(&app, &url(song.id.0, "cover")).await,
            std::fs::read(songs.join(folder).join(cover)).unwrap(),
            "{folder}: cover"
        );
        assert_eq!(
            fetch(&app, &url(song.id.0, "background")).await,
            std::fs::read(songs.join(folder).join(background)).unwrap(),
            "{folder}: background"
        );
    }

    // No video, length from ffprobe.
    let named = summary(&app, "Named Cover").await;
    assert!(!named.has_video);
    let length = named.length_seconds.expect("probed");
    assert!((1.9..2.2).contains(&length), "{length}");

    // The tile: a palette colour, for cover and background alike, the same
    // after a restart.
    let tile = detail(&app, "Tile").await;
    let SongArtwork::Tile { colour } = tile.media.cover.clone() else {
        panic!(
            "a Song without a cover gets the tile: {:?}",
            tile.media.cover
        );
    };
    assert_eq!(tile.media.background, SongArtwork::Tile { colour });
    assert_eq!(
        summary(&app, "Tile").await.cover,
        SongArtwork::Tile { colour }
    );
    let missing = app
        .http()
        .get(app.url(&url(tile.id.0, "cover")))
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 404);

    app.restart().await;
    assert_eq!(
        detail(&app, "Tile").await.media.cover,
        SongArtwork::Tile { colour }
    );

    // Nothing changed: nothing is probed again. A changed file is.
    let report = rescan(&app, 2).await;
    assert_eq!(report.probed, 0);
    std::fs::copy(
        media.dir().join("clip.mp4"),
        songs.join("Two Files/clip.avi"),
    )
    .unwrap();
    let report = rescan(&app, 3).await;
    assert_eq!(report.probed, 1);
    let two = detail(&app, "Two Files").await;
    assert_eq!(
        two.media.video,
        Some(SongVideo::File {
            file: MediaFile {
                url: url(two.id.0, "video"),
                native: true
            },
            gap_seconds: 1.5,
        })
    );
}

#[tokio::test]
async fn media_is_served_with_range_requests() {
    let media = Media::new();
    let app = TestApp::builder().folders(library(&media)).start().await;
    let id = summary(&app, "Named Cover").await.id.0;
    let whole = std::fs::read(app.songs_dir().join("Named Cover/tone.ogg")).unwrap();

    let response = app
        .http()
        .get(app.url(&url(id, "audio")))
        .header("Range", "bytes=10-19")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 206);
    assert_eq!(
        response.headers()["content-range"],
        format!("bytes 10-19/{}", whole.len()).as_str()
    );
    assert_eq!(response.bytes().await.unwrap().as_ref(), &whole[10..20]);

    for path in [url(id, "video"), url(id, "lyrics"), url(99_999, "audio")] {
        let response = app.http().get(app.url(&path)).send().await.unwrap();
        assert_eq!(response.status(), 404, "{path}");
    }
}

async fn fetch(app: &TestApp, path: &str) -> Vec<u8> {
    let response = app.http().get(app.url(path)).send().await.unwrap();
    assert_eq!(response.status(), 200, "{path}");
    response.bytes().await.unwrap().to_vec()
}
