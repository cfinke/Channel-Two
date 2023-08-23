jQuery( function ( $ ) {
	var options = {
		showNowPlaying : true
	};

	/**
	 * How much logging?
	 * 0 = none
	 * 1 = Program starts/stops/ads
	 * 2 = Everything
	 * 3 = Everything and more
	 */
	var logLevel = 2;

	/**
	 * The jQuery representation of the <video> tag.
	 */
	var tv = $( '#tv' );
	var tvElement = tv.get(0);

	var canvas = null;
	var context = null;

	if ( typeof OffscreenCanvas !== 'undefined' ) {
		canvas = new OffscreenCanvas( 100, 100 );
		context = canvas.getContext( '2d' );
	}

	/**
	 * The timer for the currently pending programming check.
	 */
	var nextProgrammingTimerId = null;

	/**
	 * When watching for ad breaks, how many dark frames have we seen in a row?
	 */
	var consecutiveDarkFrames = 0;

	/**
	 * What is the default minimum time (in seconds) between ad breaks?
	 */
	var minimumSecondsBetweenAdBreaks = 10 * 60;

	/**
	 * When was the last ad break?
	 */
	var lastAdBreak = 0;

	/**
	 * The timer for the currently pending commercial break check.
	 */
	var commercialBreakTimerId = null;

	var programmingQueue = [];

	var chyronTimerId = null;

	/**
	 * Should captions be turned on regardless of the setting in the schedule? Press C to enable.
	 * Note that there's no way to turn captions off if they've been enabled in the schedule file.
	 */
	var captionOverride = false;

	/**
	 * Webpages can't autoplay video or go full-screen without some interaction from the user,
	 * so require a button to be clicked to kick things off.
	 */
	$( '#start' ).on( 'click', function () {
		if ( logLevel >= 2 ) console.log( "#start.click()" );

		// Periodically re-fetch the programming schedule in case new content has been added (or changed, or removed, or...)
		setInterval( refreshProgramming, 5 * 60 * 1000 );

		if ( 'requestFullscreen' in document.documentElement ) {
			document.documentElement.requestFullscreen();
		} else if ( 'webkitRequestFullScreen' in document.documentElement ) {
			document.documentElement.webkitRequestFullScreen();
		} else if ( 'mozRequestFullScreen' in document.documentElement ) {
			document.documentElement.mozRequestFullScreen();
		}

		if ( logLevel >= 2 ) console.log( "Looking for content that should be playing." );

		// When the app is first loaded, see if there's a program we should be playing already, and
		// if so, begin playback at the appropriate position.
		let minutesAgo = 0;
		let now = new Date();

		timeLoop : while ( minutesAgo < ( 24 * 60 ) ) {
			if ( logLevel >= 3 ) console.log( "Checking " + minutesAgo + " minutes ago" );

			let adjustedTime = new Date( now.valueOf() - ( minutesAgo * 60 * 1000 ) );

			for ( let cron in programming.schedule ) {
				if ( cron.indexOf( '* ' ) === 0 ) {
					if ( logLevel >= 3 ) console.log( "Skipping cron " + cron );

					// Skip anything that is set as the backup for all the time. If there's nothing
					// that's supposed to be playing now, it will be found later anyway.
					continue;
				}

				if ( Cron.timeMatchesCron( adjustedTime, cron ) ) {
					if ( logLevel >= 2 ) console.log( "Found matching cron: " + cron, programming.schedule[cron] );

					// Confirm there's content long enough that it would still be playing.
					let nextContent = getNextContentFromCron( cron );

					if ( logLevel >= 2 ) console.log( nextContent + " would have played." );

					// It doesn't matter if the file is long enough to reach the given duration.
					// If it's not, it will end immediately and the 'ended' event will kick in.
					programmingQueue.push( {
						src: nextContent + '#t=' + ( ( minutesAgo * 60 ) + now.getSeconds() ),
						cron : cron
					} );

					break timeLoop;
				}
			}

			minutesAgo++;
		}

		queueNextProgramming();

		// Remove this button, as it won't be needed again.
		$( this ).remove();
	} );

	/**
	 * For debugging, when the screen is clicked, fast-forward the current program to its end.
	 */
	$( '#overlay' ).on( 'click', function () {
		if ( logLevel >= 2 ) console.log( "#overlay.click()" );

		if ( tvElement.duration ) {
			tvElement.currentTime = tvElement.duration;
		}
	} );

	/**
	 * When something goes wrong, just skip this video and move on.
	 */
	tv.on( 'error', function ( e ) {
		console.log( e );

		tv.removeAttr( 'src' );
		tv.removeData( 'cron' );
		tvElement.ended = true;

		clearTimeout( commercialBreakTimerId );

		queueNextProgramming();
	} );

	tv.on( 'ended', function () {
		if ( logLevel >= 1 ) console.log( "TV has stopped playing." );

		let currentCron = tv.data( 'cron' );

		clearTimeout( commercialBreakTimerId );

		if ( currentCron in programming.schedule && programming.schedule[ currentCron ].flags.ads ) {
			let adBreakScheduled = adBreak();

			if ( adBreakScheduled ) {
				// adBreak() calls queueNextProgramming() already.
				return;
			}
		}

		// @todo If there are less than ~30 seconds until the next non-wildcard programming,
		// just show the "We'll be right back graphic.

		// Find what to play next.
		queueNextProgramming();
	} );

	tvElement.addEventListener( 'loadeddata', function () {
		// Video is loaded and can be played
		if ( logLevel >= 2 ) console.log( "tvElement.loadeddata()" );

		clearTimeout( commercialBreakTimerId );

		// Start watching for ad breaks after 90 seconds.
		commercialBreakTimerId = setTimeout( watchForCommercialBreak, 90 * 1000 );

		let currentVideoSrc = tv.attr( 'src' ).split( '#t=' )[0];

		if ( ! currentVideoSrc ) {
			if ( logLevel >= 2 ) console.log( "Couldn't find video source." );
		} else {
			currentVideoSrc = decodePathParts( currentVideoSrc );

			let duration = tvElement.duration;

			if ( ! duration ) {
				if ( logLevel >= 2 ) console.log( "Couldn't find duration." );
			} else {
				if ( logLevel >= 2 ) console.log( "The duration of " + currentVideoSrc + " is " + duration + " seconds" );

				// It makes life easier knowing the duration before a video plays, so save the duration in case we didn't pre-calculate it.
				let durationSaved = saveDuration( currentVideoSrc, duration );

				if ( logLevel >= 2 ) console.log( "Saved duration of " + currentVideoSrc + "; return value was " + durationSaved );
			}
		}

		if ( tv.attr( 'src' ).indexOf( '#t=' ) !== -1 ) {
			let timestamp = parseFloat( tv.attr( 'src' ).split( '#t=' )[1] );

			if ( timestamp < 0 ) {
				if ( logLevel >= 2 ) console.log( "The timestamp is negative: " + timestamp );

				// When given a negative timstamp, seek to that many seconds from the end.
				let secondsFromEnd = timestamp * -1;

				if ( tvElement.duration ) {
					let seekToSeconds = tvElement.duration - secondsFromEnd;

					if ( logLevel >= 2 ) console.log( "Seeking to " + seekToSeconds );

					tvElement.currentTime = seekToSeconds;
				} else {
					if ( logLevel >= 2 ) console.log( "No duration available, so we can't seek." );
				}
			}
		}
	}, false );

	/**
	 * Watch for moments during programming when the screen fades to black, and use that as an
	 * opportunity for a commercial break, if applicable.
	 */
	function watchForCommercialBreak() {
		if ( logLevel >= 3 ) console.log( 'watchForCommercialBreak()' );

		clearTimeout( commercialBreakTimerId );

		if ( ! context ) {
			if ( logLevel >= 2 ) console.log( "OffscreenCanvas is not available, so bailing from watchForCommercialBreak()" );

			return;
		}

		// If the video isn't playing, don't loop
		if ( tvElement.paused || tvElement.ended ) {
			if ( logLevel >= 3 ) console.log( "paused or ended: " + tvElement.paused + "/" +tvElement.ended );

			consecutiveDarkFrames = 0;

			return false;
		}

		if ( tv.data( 'cron' ) === 'ads' ) {
			// Don't do an ad break during ads. :)

			consecutiveDarkFrames = 0;

			return;
		}

		if ( tvElement.duration ) {
			// Leave more time between ad breaks in longer programming.
			if ( tvElement.duration < 60 * 30 ) {
				minimumSecondsBetweenAdBreaks = 60 * 8;
			} else if ( tvElement.duration < 60 * 60 ) {
				minimumSecondsBetweenAdBreaks = 60 * 12;
			} else {
				minimumSecondsBetweenAdBreaks = 60 * 20;
			}

			if ( logLevel >= 3 ) console.log( "minimumSecondsBetweenAdBreaks: " + minimumSecondsBetweenAdBreaks );
		}

		// Draw the current frame of the video onto the hidden canvas
		context.drawImage( tvElement, 0, 0, canvas.width, canvas.height );

		// Pull the image data from the canvas
		let frame_data = context.getImageData( 0, 0, canvas.width, canvas.height ).data;

		// Get the length of the data, divide that by 4 to get the number of pixels
		// then divide that by 4 again so we check the color of every 4th pixel
		let frame_data_length = (frame_data.length / 4);

		let pixel_count = 0;
		let rgb_sums = [0, 0, 0];
		for(let i = 0; i < frame_data_length; i += 4 ){
			rgb_sums[0] += frame_data[i];
			rgb_sums[1] += frame_data[i+1];
			rgb_sums[2] += frame_data[i+2];
			pixel_count++;
		}

		// Average the rgb sums to get the average color of the frame in rgb
		rgb_sums[0] = Math.floor(rgb_sums[0]/pixel_count);
		rgb_sums[1] = Math.floor(rgb_sums[1]/pixel_count);
		rgb_sums[2] = Math.floor(rgb_sums[2]/pixel_count);

		let averageSaturation = ( ( rgb_sums[0] + rgb_sums[1] + rgb_sums[2] ) / 3 );

		if ( averageSaturation < 10 ) {
			consecutiveDarkFrames++;

			if ( consecutiveDarkFrames >= 8 ) {
				let now = new Date();

				// Possible ad break.
				// @todo This seems to trigger right when something starts playing.
				if ( logLevel >= 2 ) console.log( "Now would be a great time for an ad break!" );

				consecutiveDarkFrames = 0;

				if ( ( now - lastAdBreak ) < ( minimumSecondsBetweenAdBreaks * 1000 ) ) {
					if ( logLevel >= 2 ) console.log( "But it's too soon since last ad break (" + ( ( new Date() ) - lastAdBreak ) / 1000 + ") seconds" );

					commercialBreakTimerId = setTimeout( watchForCommercialBreak, 5 * 1000 );
				} else {
					let tookAdBreak = adBreak();

					if ( ! tookAdBreak ) {
						// If we didn't take an ad break, allow the commercial break check to keep going.
						commercialBreakTimerId = setTimeout( watchForCommercialBreak, 5 * 1000 );
					}
				}

				return;
			}
		} else {
			consecutiveDarkFrames = 0;
		}

		commercialBreakTimerId = setTimeout( watchForCommercialBreak, 100 );
	}

	/**
	 * Potentially take a break for some ads.
	 *
	 * @return bool Whether a break was scheduled and taken.
	 */
	function adBreak() {
		if ( logLevel >= 2 ) console.log( "adBreak()" );

		let currentCron = tv.data( 'cron' );

		if ( ! programming.schedule[ currentCron ].flags.ads ) {
			// Ads are disabled right now.
			return;
		}

		// Pick some ads.

		programmingQueue = [];

		// How much time is left in this program?
		let secondsUntil = secondsUntilNextProgram();

		if ( logLevel >= 2 ) console.log( "There are " + secondsUntil + " seconds until the next program." );

		let secondsLeft = secondsLeftInCurrentProgram();

		if ( logLevel >= 2 ) console.log( "There are " + secondsLeft + " seconds left in the current program." );

		if (
			secondsLeft < secondsUntil     // A program might be longer than the slot it's scheduled for.
			&& secondsUntil > 0            // The next program might be beginning right now.
			&& secondsLeft !== false
			&& ( secondsLeft > 90 || secondsLeft === 0 ) // And don't schedule anything in the last 90 seconds of a program, but right after is ok.
		) {
			let timeForAds = secondsUntil - secondsLeft;
			let maxAds = 1000;

			if ( secondsLeft > 0 ) {
				if ( logLevel >= 2 ) console.log( "Scheduling a max of 5 ads." );

				// In the middle of a program, play max 5 ads.
				maxAds = 5;
			} else {
				let now = new Date();

				// Don't schedule ads past the next half-hour mark.
				timeForAds = Math.min(
					timeForAds,
					( ( 30 - ( now.getMinutes() % 30 ) ) * 60 ) - now.getSeconds()
				);

				if ( logLevel >= 2 ) console.log( "Scheduling a max of " + timeForAds + " seconds of ads, which brings us to the next half hour." );
			}

			if ( logLevel >= 2 ) console.log( "Allotting " + timeForAds + " seconds for ads." );

			let adsThatMatch = [];

			for ( let file in programming.ad_index ) {
				if ( file.indexOf( programming.schedule[ currentCron ].flags.ads ) !== 0 ) {
					continue;
				}

				adsThatMatch.push( file );
			}

			if ( logLevel >= 2 ) console.log( "adsThatMatch: ", adsThatMatch );

			let totalAdTime = 0;

			for ( let i = 0; i < maxAds; i++ ) {
				let randomIndex = Math.floor( Math.random() * adsThatMatch.length );

				if ( logLevel >= 2 ) console.log( "randomIndex and adsThatMatch.length: ", randomIndex, adsThatMatch.length );

				let randomAd = adsThatMatch[ randomIndex ];

				if ( logLevel >= 2 ) console.log( "randomIndex: ", randomIndex );

				let adDuration = getDuration( randomAd );

				if ( false === adDuration ) {
					if ( logLevel >= 2 ) console.log( "No duration available for " + randomAd + "; assuming one minute." );
					adDuration = 60;
				}

				if ( totalAdTime + adDuration > timeForAds ) {
					if ( logLevel >= 2 ) console.log( "Finished scheduling " + totalAdTime + " seconds of ad time." );
					break;
				}

				if ( adDuration > timeForAds ) {
					if ( logLevel >= 2 ) console.log( "This ad (" + randomAd + ") is longer (" + adDuration + ") than the total time for ads (" + timeForAds + "), so skipping it and ending ad schedule." );
					break;
				}

				totalAdTime += adDuration;

				if ( logLevel >= 2 ) console.log( "Queueing ad " + randomAd + " (" + adDuration + " seconds)" );

				programmingQueue.push( {
					src: randomAd,
					cron : 'ads',
					secondsUntil : secondsUntil,
					secondsLeft : secondsLeft,
					timeForAds : timeForAds,
					now : new Date()
				} );
			}
		} else {
			if ( logLevel >= 2 ) console.log( "Skipping ad scheduling due to secondsUntil/secondsLeft: " + secondsUntil + "/" + secondsLeft );
		}

		// If we scheduled any ads, pause the current show and add the rest of it to the queue.
		if ( programmingQueue.length > 0 ) {
			lastAdBreak = new Date();

			// Add the rest of the current program to the queue.
			programmingQueue.push( {
				src : decodePathParts( tv.attr( 'src' ).split( '#t=' )[0] ) + '#t=' + tvElement.currentTime,
				cron : currentCron
			} );

			if ( logLevel >= 2 ) console.log( "programmingQueue: ", programmingQueue );

			tvElement.pause();

			// Now start playing them.
			queueNextProgramming();

			return true;
		} else {
			return false;
		}
	}

	function queueNextProgramming() {
		if ( logLevel >= 2 ) console.log( "queueNextProgramming()" );

		clearTimeout( nextProgrammingTimerId );

		let now = new Date();

		let secondsUntilNextMinute = ( 60 - now.getSeconds() );

		if ( programmingQueue.length > 0 ) {
			if ( logLevel >= 2 ) console.log( "Choosing from the programming queue:", programmingQueue );

			let nextProgram = programmingQueue.shift();

			let nextFileToPlay = nextProgram.src;
			let cron = nextProgram.cron;

			saveLastPlay( cron, nextFileToPlay );

			tv.data( 'cron', cron );
			play( nextFileToPlay );

			// If this cron pattern matches every minute, this content should end if something else should be run.
			if ( cron.indexOf( '* ' ) === 0 ) {
				if ( logLevel >= 2 ) console.log( "Wildcard programming is playing; checking for more important content in " + secondsUntilNextMinute + " seconds." );

				// We could skip setting this timer if the content duration is less than a minute, but
				// I think it simplifies the logic if there's always a timer waiting during wildcard programming.
				nextProgrammingTimerId = setTimeout( queueNextProgramming, ( secondsUntilNextMinute + 1 ) * 1000 );
			}

			return;
		}

		let cronForThisMinute = false;

		for ( cron in programming.schedule ) {
			if ( Cron.timeMatchesCron( now, cron ) ) {
				if ( cron.indexOf( '* ' ) === 0 && tv.data( 'cron' ) && ! tvElement.ended ) {
					if ( logLevel >= 2 ) console.log( "Found matching wildcard cron (" + cron + ") but skipping because something is playing." );
				} else {
					if ( logLevel >= 2 ) console.log( "Found matching cron: " + cron, programming.schedule[cron] );

					cronForThisMinute = cron;
					break;
				}
			} else {
				if ( logLevel >= 2 ) console.log( cron + " doesn't match this minute (" + now + ")" );
			}
		}

		let nextFileToPlay = false;

		if ( cronForThisMinute ) {
			nextFileToPlay = getNextContentFromCron( cron );

			if ( tv.attr( 'src' ) && nextFileToPlay ) {
				if ( tv.attr( 'src' ).indexOf( nextFileToPlay ) == 0 ) {
					if ( logLevel >= 2 ) console.log( "Don't play the same file twice in a row in the same minute." );
					nextFileToPlay = false;
				}
			}
		}

		if ( nextFileToPlay ) {
			saveLastPlay( cron, nextFileToPlay );

			tv.data( 'cron', cron );
			play( nextFileToPlay );

			// If this cron pattern matches every minute, this content should end if something else should be run.
			if ( cron.indexOf( '* ' ) === 0 ) {
				if ( logLevel >= 2 ) console.log( "Wildcard programming is playing; checking for more important content in " + secondsUntilNextMinute + " seconds." );

				// We could skip setting this timer if the content duration is less than a minute, but
				// I think it simplifies the logic if there's always a timer waiting during wildcard programming.
				nextProgrammingTimerId = setTimeout( queueNextProgramming, ( secondsUntilNextMinute + 1 ) * 1000 );
			}
		} else {
			if ( logLevel >= 2 ) console.log( "No cron found for this minute (" + now + "); trying again in " + secondsUntilNextMinute + " seconds." );

			// The TV might be currently playing right now; if it is, it's wildcard programming, and we should let it keep going.

			if ( tvElement.ended ) {
				tv.removeData( 'cron' );
				tv.removeAttr( 'src' );
				tvElement.load();
			}

			if ( ! tv.data( 'cron' ) ) {
				$( '#right-back' ).show();
			}

			nextProgrammingTimerId = setTimeout( queueNextProgramming, ( secondsUntilNextMinute + 1 ) * 1000 );
		}
	}

	/**
	 * Play a given file in the video player.
	 */
	function play( path ) {
		if ( logLevel >= 1 ) console.log( "play( " + path + " )" );

		clearTimeout( chyronTimerId );

		$( '#right-back' ).hide();

		tv.removeAttr( 'src' );
		tv.empty();

		tv.attr( 'src', encodePathParts( path ) );
		addCaptions( path );
		setCaptionStatus();

		tvElement.load();

		// For non-ad content, show a "now playing: " chyron.
		if ( options.showNowPlaying && tv.data( 'cron' ) != 'ads' ) {
			let displayName = path;

			// Get rid of the timestamp.
			let displayNameParts = displayName.split( '#t=' );

			if ( displayNameParts.length > 1 ) {
				displayNameParts.pop();
			}

			displayName = displayNameParts.join( '#t=' );

			// Get rid of the extension.
			displayNameParts = displayName.split( '.' );

			if ( displayNameParts.length > 1 ) {
				displayNameParts.pop();
			}

			displayName = displayNameParts.join( '.' );

			// Get the filename part.
			displayNameParts = displayName.split( '/' );
			displayName = displayNameParts.pop();

			displayName = displayName.replace( /\(.*?\)/, '' );
			displayName = displayName.trim();

			$( '#chyron-banner' ).text( displayName );
			$( '#overlay' ).addClass( 'chyroned' );
		}

		tvElement.play().then( function () {
			chyronTimerId = setTimeout( function () {
				$( '#overlay' ).animate( { opacity: 0 }, 1000, function () {
					$( '#overlay' ).removeClass( 'chyroned' ).css( 'opacity', 1 );
				} );
			}, 5000 );
		} ).catch( function ( e ) {
			// Probably a file that can't be loaded or doesn't exist.
			console.log( "tvElement.play() exception: ", e );

			tv.removeAttr( 'src' );
			tv.removeData( 'cron' );
			tvElement.ended = true;

			clearTimeout( commercialBreakTimerId );

			queueNextProgramming();
		} );
	}

	function addCaptions( path ) {
		if ( logLevel >= 1 ) console.log( "addCaptions(" + path + ")" );

		tv.empty();

		let captions = getCaptions( path );

		if ( captions ) {
			let track = $( '<track/>' )
				.attr( 'kind', 'captions' )
				.attr( 'src', encodePathParts( captions ) )
				.attr( 'default', 'default' );

			tv.append( track );

			if ( logLevel >= 1 ) console.log( "added captions" );
		} else {
			if ( logLevel >= 1 ) console.log( "There were no captions to add." );
		}
	}

	function setCaptionStatus() {
		let currentCron = tv.data( 'cron' );

		if ( 'textTracks' in tvElement ) {
			if ( logLevel >= 2 ) console.log( "There are " + tvElement.textTracks.length + " text tracks." );

			for ( let i = 0; i < tvElement.textTracks.length; i++ ) {
				if ( captionOverride || ( currentCron in programming.schedule && programming.schedule[ currentCron ].flags.captions ) ) {
					if ( logLevel >= 2 ) console.log( "Enabling text track " + i );

					tvElement.textTracks[i].mode = 'showing';
				} else {
					if ( logLevel >= 2 ) console.log( "Disabling text track " + i );

					tvElement.textTracks[i].mode = 'hidden';
				}
			}
		} else {
			if ( logLevel >= 1 ) console.log( "This browser does not support textTracks." );
		}
	}

	/**
	 * Given a cron pattern, find the next video that should be played.
	 * For a file or URL, it's the file or URL. For a directory, it's the video that comes alphabetically, or a random one if shuffle is enabled.
	 *
	 * @param string cron A cron pattern, like "0 10 * * *"
	 * @return string|bool Either a path to a video or false if none is available.
	 */
	function getNextContentFromCron( cron ) {
		if ( logLevel >= 2 ) console.log( "getNextContentFromCron( " + cron + " )" );

		let programmingDetails = programming.schedule[cron];

		let potentialFiles = [];

		for ( let i = 0; i < programming.schedule[cron].content.length; i++ ){
			if ( 'url' in programming.schedule[cron].content[i] ) {
				if ( potentialFiles.indexOf( programming.schedule[cron].content[i].url ) == -1 ) {
					potentialFiles.push( programming.schedule[cron].content[i].url );
				}
			} else if ( 'file' in programming.schedule[cron].content[i] ) {
				if ( potentialFiles.indexOf( programming.schedule[cron].content[i].file ) == -1 ) {
					potentialFiles.push( programming.schedule[cron].content[i].file );
				}
			} else if ( 'dir' in programming.schedule[cron].content[i] ) {
				for ( let file in programming.content_index ) {
					if ( file.indexOf( programming.schedule[cron].content[i].dir ) !== 0 ) {
						if ( file > programming.schedule[cron].content[i].dir ) {
							// We've passed all of the relevant files, so we can quit.
							break;
						} else {
							continue;
						}
					}

					if ( potentialFiles.indexOf( file ) == -1 ) {
						potentialFiles.push( file );
					}
				}
			} else {
				alert( "Unknown programming type: " + JSON.stringify( programming.schedule[cron].content[i] ) );
			}
		}

		if ( logLevel >= 2 ) console.log( "Potential files for " + cron + ": ", potentialFiles );

		if ( programming.schedule[cron].flags.shuffle ) {
			if ( logLevel >= 2 ) console.log( "shuffle is enabled" );

			// Pick a random one.

			let randomIndex = Math.floor( Math.random() * potentialFiles.length );
			return potentialFiles[ randomIndex ];
		} else {
			if ( logLevel >= 2 ) console.log( "shuffle is disabled" );

			potentialFiles.sort();

			let lastPlayedContent = getLastPlay( cron );

			if ( logLevel >= 2 ) console.log( "The last played file for " + cron + " was " + lastPlayedContent );

			let itsTheNextOne = false;
			let firstContent = false;

			for ( let i = 0; i < potentialFiles.length; i++ ) {
				let file = potentialFiles[i];

				if ( ! lastPlayedContent ) {
					if ( logLevel >= 2 ) console.log( "No content has been played for this cron, returning " + file );
					return file;
				}

				if ( ! firstContent ) {
					// Just in case we need it.
					firstContent = file;
				}

				if ( itsTheNextOne ) {
					if ( logLevel >= 2 ) console.log( "Returning the next one: " + file );
					return file;
				} else if ( file == lastPlayedContent ) {
					if ( logLevel >= 2 ) console.log( "Found " + lastPlayedContent + " in list, returning the next one." );
					itsTheNextOne = true;
				}
			}

			if ( logLevel >= 2 ) console.log( "Never found " + lastPlayedContent + " in the file list (or it was the last one); returning the first one: " + firstContent );

			return firstContent;
		}

		if ( logLevel >= 2 ) console.log( "Found no next content from cron " + cron );

		return false;
	}

	/**
	 * Given a cron pattern, find the previous video that would have played.
	 * For a file or URL, it's the file or URL. For a directory, it's the video that comes prior alphabetically, or a random one if shuffle is enabled.
	 *
	 * @param string cron A cron pattern, like "0 10 * * *"
	 * @return string|bool Either a path to a video or false if none is available.
	 */
	function getPreviousContentFromCron( cron ) {
		if ( logLevel >= 2 ) console.log( "getPreviousContentFromCron( " + cron + " )" );

		let programmingDetails = programming.schedule[cron];

		let potentialFiles = [];

		for ( let i = 0; i < programming.schedule[cron].content.length; i++ ){
			if ( 'url' in programming.schedule[cron].content[i] ) {
				if ( potentialFiles.indexOf( programming.schedule[cron].content[i].url ) == -1 ) {
					potentialFiles.push( programming.schedule[cron].content[i].url );
				}
			} else if ( 'file' in programming.schedule[cron].content[i] ) {
				if ( potentialFiles.indexOf( programming.schedule[cron].content[i].file ) == -1 ) {
					potentialFiles.push( programming.schedule[cron].content[i].file );
				}
			} else if ( 'dir' in programming.schedule[cron].content[i] ) {
				for ( let file in programming.content_index ) {
					if ( file.indexOf( programming.schedule[cron].content[i].dir ) !== 0 ) {
						if ( file > programming.schedule[cron].content[i].dir ) {
							// We've passed all of the relevant files, so we can quit.
							break;
						} else {
							continue;
						}
					}

					if ( potentialFiles.indexOf( file ) == -1 ) {
						potentialFiles.push( file );
					}
				}
			} else {
				alert( "Unknown programming type: " + JSON.stringify( programming.schedule[cron].content[i] ) );
			}
		}

		if ( logLevel >= 2 ) console.log( "Potential files for " + cron + ": ", potentialFiles );

		if ( programming.schedule[cron].flags.shuffle ) {
			if ( logLevel >= 2 ) console.log( "shuffle is enabled" );

			// Pick a random one.

			let randomIndex = Math.floor( Math.random() * potentialFiles.length );
			return potentialFiles[ randomIndex ];
		} else {
			if ( logLevel >= 2 ) console.log( "shuffle is disabled" );

			potentialFiles.sort();
			potentialFiles.reverse();

			let lastPlayedContent = getLastPlay( cron );

			if ( logLevel >= 2 ) console.log( "The last played file for " + cron + " was " + lastPlayedContent );

			let itsTheNextOne = false;
			let firstContent = false;

			for ( let i = 0; i < potentialFiles.length; i++ ) {
				let file = potentialFiles[i];

				if ( ! lastPlayedContent ) {
					if ( logLevel >= 2 ) console.log( "No content has been played for this cron, returning " + file );
					return file;
				}

				if ( ! firstContent ) {
					// Just in case we need it.
					firstContent = file;
				}

				if ( itsTheNextOne ) {
					if ( logLevel >= 2 ) console.log( "Returning the next one: " + file );
					return file;
				} else if ( file == lastPlayedContent ) {
					if ( logLevel >= 2 ) console.log( "Found " + lastPlayedContent + " in list, returning the next one." );
					itsTheNextOne = true;
				}
			}

			if ( logLevel >= 2 ) console.log( "Never found " + lastPlayedContent + " in the file list (or it was the last one); returning the last one: " + firstContent );

			return firstContent;
		}

		if ( logLevel >= 2 ) console.log( "Found no previous content from cron " + cron );

		return false;
	}

	/**
	 * Get the stored play history -- a hash keyed by cron pattern containing the last video path that finished (or was interrupted).
	 *
	 * @return Object
	 */
	function getPlayHistory() {
		if ( logLevel >= 3 ) console.log( "getPlayHistory()" );

		if ( 'playHistory' in localStorage ) {
			try {
				return JSON.parse( localStorage.playHistory );
			} catch ( error ) {
				if ( logLevel >= 2 ) console.log( "playHistory was malformed (" + localStorage.playHistory + ")", error );
			}
		}

		return {};
	}

	/**
	 * Save the playHistory
	 */
	function setPlayHistory( history ) {
		if ( logLevel >= 3 ) console.log( "setPlayHistory()" );

		let stringHistory = null;

		try {
			stringHistory = JSON.stringify( history );
		} catch ( error ) {
			if ( logLevel >= 2 ) console.log( "Couldn't stringify playHistory", error );
			stringHistory = JSON.stringify( {} );
		}

		localStorage.setItem( 'playHistory', stringHistory );
	}

	function saveLastPlay( cron, file ) {
		file = file.split( '#t=' )[0]; // Remove any timestamp.

		let playHistory = getPlayHistory();
		playHistory[cron] = file;
		setPlayHistory( playHistory );
	}

	function getLastPlay( cron ) {
		let playHistory = getPlayHistory();

		let lastPlayedContent = false;

		if ( cron in playHistory ) {
			return playHistory[cron];
		}

		return false;
	}

	/**
	 * Find the duration, in seconds, of a given file.
	 *
	 * @return int|bool The duration, or false if not available.
	 */
	function getDuration( filePath ) {
		if ( logLevel >= 2 ) console.log( "getDuration(" + filePath + ")" );

		if ( filePath in programming.content_index ) {
			if ( logLevel >= 2 ) console.log( "Found " + filePath + " in content_index" );

			if ( 'duration' in programming.content_index[ filePath ] ) {
				return programming.content_index[ filePath ].duration;
			} else {
				if ( logLevel >= 2 ) console.log( "But didn't find duration in  programming.content_index[ filePath ]" );
			}
		}

		if ( filePath in programming.ad_index ) {
			if ( logLevel >= 2 ) console.log( "Found " + filePath + " in ad_index" );

			if ( 'duration' in programming.ad_index[ filePath ] ) {
				return programming.ad_index[ filePath ].duration;
			} else {
				if ( logLevel >= 2 ) console.log( "But didn't find duration in  programming.ad_index[ filePath ]" );
			}
		}

		if ( logLevel >= 2 ) console.log( "Could not find " + filePath + " with duration in content_index or ad_index" );

		if ( 'durations' in localStorage ) {
			let durations = JSON.parse( localStorage.durations );

			if ( filePath in durations ) {
				if ( logLevel >= 2 ) console.log( "Found duration in localStorage: " + durations[ filePath ] );

				return durations[ filePath ];
			}
		}

		return false;
	}

	/**
	 * If a caption file is available for a file, return its path.
	 *
	 * @return int|bool The duration, or false if not available.
	 */
	function getCaptions( filePath ) {
		if ( logLevel >= 2 ) console.log( "getCaptions(" + filePath + ")" );

		if ( filePath in programming.content_index ) {
			if ( 'captions' in programming.content_index[ filePath ] ) {
				return programming.content_index[ filePath ].captions;
			}
		} else if ( filePath in programming.ad_index ) {
			if ( 'captions' in programming.ad_index[ filePath ] ) {
				return programming.ad_index[ filePath ].captions;
			}
		}

		return false;
	}

	/**
	 * Save the duration of a file that didn't have a stored duration in programming.js
	 *
	 * @param string filePath
	 * @param float duration
	 * @return Whether the operation succeeded.
	 */
	function saveDuration( filePath, duration ) {
		if ( logLevel >= 2 ) console.log( "saveDuration( " + filePath + ", " + duration + " )" );

		let durations;

		if ( 'durations' in localStorage ) {
			try {
				durations = JSON.parse( localStorage.durations );
			} catch ( error ) {
				if ( logLevel >= 2 ) console.log( "localStorage.durations was malformed (" + localStorage.durations + ")", error );
				durations = {};
			}
		} else {
			durations = {};
		}

		durations[ filePath ] = duration;

		try {
			let stringDurations = JSON.stringify( durations );
			localStorage.setItem( 'durations', stringDurations );
		} catch ( error ) {
			if ( logLevel >= 2 ) console.log( "Couldn't stringify durations", error );
			return false;
		}

		return true;
	}

	/**
	 * Remove any stored durations for files that are no longer in the programming indices.
	 */
	function purgeDurations() {
		let durations;

		if ( 'durations' in localStorage ) {
			try {
				durations = JSON.parse( localStorage.durations );
			} catch ( error ) {
				if ( logLevel >= 2 ) console.log( "localStorage.durations was malformed (" + localStorage.durations + ")", error );
				durations = {};
			}
		} else {
			durations = {};
		}

		for ( let filePath in durations ) {
			if ( ! ( filePath in programming.ad_index ) && ! ( filePath in programming.content_index ) ) {
				if ( logLevel >= 2 ) console.log( "Forgetting duration for " + filePath );

				delete durations[ filePath ];
			}
		}

		try {
			let stringDurations = JSON.stringify( durations );
			localStorage.setItem( 'durations', stringDurations );
		} catch ( error ) {
			if ( logLevel >= 2 ) console.log( "Couldn't stringify durations", error );
		}

		return;
	}

	function secondsLeftInCurrentProgram() {
		if ( logLevel >= 2 ) console.log( "secondsLeftInCurrentProgram()" );

		let duration = tvElement.duration;

		if ( logLevel >= 2 ) console.log( "The current program duration is " + duration + " seconds." );

		if ( duration ) {
			let currentTime = tvElement.currentTime;

			if ( logLevel >= 2 ) console.log( "The current program timestamp is " + currentTime );

			if ( currentTime ) {
				return duration - currentTime;
			}
		}

		return false;
	}

	function secondsUntilNextProgram() {
		if ( logLevel >= 2 ) console.log( "secondsUntilNextProgram()" );

		let now = new Date();
		let minutesAhead = -1;
		let matchingCron = false;

		timeLoop : do {
			minutesAhead++;

			if ( logLevel >= 2 ) console.log( "Checking " + minutesAhead + " minutes ahead" );

			let adjustedTime = new Date( now.valueOf() + ( minutesAhead * 60 * 1000 ) );

			for ( let cron in programming.schedule ) {
				if ( cron.indexOf( '* ' ) === 0 ) {
					if ( logLevel >= 2 ) console.log( "Skipping cron " + cron );
					continue;
				}

				if ( Cron.timeMatchesCron( adjustedTime, cron ) ) {
					if ( minutesAhead == 0 && tvElement.currentTime < 60 ) {
						// This is actually matching the same cron that started the current program.
						// Usually, we won't be looking for the next program within the same minute
						// that the existing program started, but we do during testing.
						if ( logLevel >= 2 ) console.log( "Found a matching cron, but it's for the current program: " + cron );
					} else {
						if ( logLevel >= 2 ) console.log( "Found matching cron: " + cron, programming.schedule[cron] );

						break timeLoop;
					}
				}
			}
		} while ( ! matchingCron && minutesAhead < 24 * 60 );

		return Math.max( 0, ( minutesAhead * 60 ) - now.getSeconds() );
	}

	/**
	 * Resize various elements when the screen is resized (and when it's loaded).
	 */
	function resized() {
		if ( logLevel >= 2 ) console.log( "resized()" );

		$( '.full-screen' ).css(
			{
				'height': $( window ).height(),
				'width': $( window ).width()
			}
		);

		let bugSize = Math.round( $( window ).height() / 1080 * 60 );

		$( '#bug' ).hide().css( {
			'width': bugSize,
			'height': bugSize,
			'bottom': bugSize,
			'right': bugSize
			}
		).show();
	}

	$( window ).resize( resized );
	resized();

	/**
	 * Re-fetch the JavaScript file that was generated from the cron schedule, which updates
	 * the local `programming` variable. This allows the schedule to be changed without having
	 * to reload the page, which would require a new click interaction to keep playing.
	 */
	function refreshProgramming() {
		if ( logLevel >= 3 ) console.log( "refreshProgramming()" );

		// Reload the programming.js JavaScript by removing the script tag and adding a new one with a cache-buster.

		const script = document.createElement( 'script' );
		script.src = 'programming.js?t=' + ( new Date().getTime() );
		script.setAttribute( 'id', 'programming' );

		$( '#programming' ).remove();
		document.body.appendChild(script);

		// Clean up our stored durations to avoid using more space than we need.
		purgeDurations();
	}

	/**
	 * Encode the individual directories and filenames in a path without encoding the slashes.
	 */
	function encodePathParts( path ) {
		let pathAndTime = path.split( '#t=' );
		let pathParts = pathAndTime[0].split( '/' );
		pathParts.forEach( function ( value, idx ) {
			pathParts[ idx ] = encodeURIComponent( value );
		} );

		let returnValue = pathParts.join( '/' );

		// If there was a timestamp, add it back in.
		if ( pathAndTime[1] ) {
			returnValue += '#t=' + pathAndTime[1];
		}

		console.log( path + " encoded is " + returnValue );

		return returnValue;
	}

	/**
	 * Decode the individual directories and filenames in a path without encoding the slashes.
	 */
	function decodePathParts( path ) {
		let pathAndTime = path.split( '#t=' );
		let pathParts = pathAndTime[0].split( '/' );
		pathParts.forEach( function ( value, idx ) {
			pathParts[ idx ] = decodeURIComponent( value );
		} );

		let returnValue = pathParts.join( '/' );

		// If there was a timestamp, add it back in.
		if ( pathAndTime[1] ) {
			returnValue += '#t=' + pathAndTime[1];
		}

		return returnValue;
	}

	// Add key bindings so you can use arrow keys to advance the current programming point.

	$( document ).on( 'keyup', function ( e ) {
		if ( ! tv.data( 'cron' ) ) {
			return;
		}

		let currentCron = tv.data( 'cron' );

		switch ( e.which ) {
			case 37:
			case 39:
				// Left or right arrow
				let secondsLeft = secondsLeftInCurrentProgram();

				let switchToThisContent;

				if ( e.which == 37 ) {
					// Go to the previous episode that should have played, resuming with the same amount of time left in the current episode.
					switchToThisContent = getPreviousContentFromCron( currentCron );
				} else {
					// 39: right arrow
					// Go to the next episode that should play, resuming with the same amount of time left in the current episode.

					switchToThisContent = getNextContentFromCron( currentCron );
				}

				programmingQueue.push( {
					src: switchToThisContent + '#t=' + ( -1 * secondsLeft ),
					cron : currentCron
				} );

				queueNextProgramming();
			break;
			case 67:
				// c for captions
				if ( logLevel >= 2 ) console.log( "c keyup" );

				captionOverride = ! captionOverride;
				setCaptionStatus();
			break;
			default:
				if ( logLevel >= 2 ) console.log( e.which );
			break;
		}
	} );
} );