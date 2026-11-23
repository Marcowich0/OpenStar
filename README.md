# OpenStar
🎤 OpenStar is an open-source, self-hosted, SingStar-style karaoke game for your home server. Uses your existing UltraStar song library, runs in any browser, and turns phones into microphones and remotes. Real-time pitch scoring, duets, profiles and leaderboards. No installs needed.

see the ultrastar project for context on a similar project and for reference on the structure of the files

1) backend and songs should be hosted on a server through docker
2) client should access through a web interface
3) client device should be able to use the clients microphone (and map users to each channel)
4) client should allow for phones to join in as user + mic
5) game should be able to use an existing ultrastar library
6) the game should be able to download new songs - use same source as (https://github.com/Marcowich0/ultrastar)
7) language should be chosen based on performance 
8) should have an edit mode where users may adjust the timing of the notes to the music if these are misalligned. 
