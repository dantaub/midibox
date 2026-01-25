Always on service that records midi events from an attached midi keyboard.

This is recorded in such a way that it can be analysed later to produce sheet music as well as played back on demand via a midi device (sent back to the keyboard) or via software to the attached speakers via alsa.

The system needs to be able to show a real-time display of the midi events as they are recorded, and also be able to show a historical view of the recorded events so that you can see the last few minutes of recorded midi events.

Users will be able to connect via a mobile interface to select slices of time and label them by who was playing and the name of the song. It needs basic gap detection to help identify when a new song starts and offer automatic segmentation.

The client-side app is hosted using bun over http on port 4000.

