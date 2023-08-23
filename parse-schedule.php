<?php

/**
 * This script takes the cron-style schedule file and generates a JavaScript file that
 * the web app can use.
 *
 * This is necessary because client-side JavaScript can't enumerate files in directories.
 */

/**
 * Usage: php parse-schedule.php --schedule schedule.txt
 *        By default, the script will read the existing programming.js file in order to
 *        re-use any previously computed durations. To force it to re-examine every
 *        file, add the optional --flush parameter.
 */

$options = getopt( '', array( 'schedule:', 'flush' ) );

if ( ! isset( $options['schedule'] ) ) {
	die( "You must specify a schedule file: php parse-schedule.php --schedule schedule.txt\n" );
}

$lines = file( $options['schedule'] );

// When running Channel Two through a Web server, you need to specify the document root
// so the script knows where to find the files in the filesystem when compiling the
// programming data.
//
// base=/path/to/public_html

$base = '';

$schedule = array(
	'schedule' => array(),
	'content_index' => array(),
	'ad_index' => array(),
);

$flags = array(
	'ads' => false,
	'shuffle' => false,
	'captions' => false,
);

$existing_programming = false;

if ( ! isset( $options['flush'] ) ) {
	if ( file_exists( './programming.js' ) ) {
		$existing_programming_text = file_get_contents( './programming.js' );
		$existing_programming_text = preg_replace( '/^var programming = /', '', $existing_programming_text );
		$existing_programming_text = preg_replace( '/;$/', '', $existing_programming_text );

		if ( $existing_programming_text ) {
			$existing_programming = json_decode( $existing_programming_text );
		}
	}
}

function existing_duration( $path ) {
	global $existing_programming;

	if ( ! $existing_programming ) {
		return false;
	}

	if ( isset( $existing_programming->content_index->{ $path } ) && isset( $existing_programming->content_index->{ $path }->duration ) ) {
//		echo "Found " . $path . "\n";
		return $existing_programming->content_index->{ $path }->duration;
	} else if ( isset( $existing_programming->ad_index->{ $path } ) && isset( $existing_programming->ad_index->{ $path }->duration ) ) {
//		echo "Found ad " . $path . "\n";
		return $existing_programming->ad_index->{ $path }->duration;
	} else {
//		echo "Didn't find " . $path . "\n";
	}

	return false;
}

foreach ( $lines as $line ) {
	// Remove comments.
	$line = preg_replace( '/#.*$/', '', $line );
	$line = trim( $line );

	if ( ! $line ) {
		continue;
	}

	// Normalize all whitespace to single spaces.
	$line = preg_replace( '/\s+/', ' ', $line );

	// Is it a variable or a schedule entry?

	if ( stripos( $line, 'base=' ) === 0 ) {
		// Setting the base URI for video paths.
		list( $unused, $base ) = explode( '=', $line, 2 );
		$base = rtrim( $base, '/' ) . '/';
		continue;
	}


	$valid_flags = array( 'ads', 'shuffle', 'captions', );

	if ( preg_match( '/^(' . join( '|', $valid_flags ) . ')=/', $line ) ) {
		// Variable.
		$parts = explode( '=', $line, 2 );
		$parts = array_map( 'trim', $parts );

		switch( $parts[0] ) {
			case 'ads':
				if ( strtolower( $parts[1] ) == 'false' ) {
					$flags['ads'] = false;
				} else {
					if ( ! file_exists( add_base( $parts[1] ) ) ) {
						die( 'Ads path does not exist: ' . add_base( $parts[1] ) . "\n" );
					}

					$parts[1] = rtrim( $parts[1], '/' ) . '/';

					$flags['ads'] = $parts[1];
				}
			break;
			case 'shuffle':
			case 'captions':
				if ( strtolower( $parts[1] ) == 'true' ) {
					$flags[ $parts[0] ] = true;
				} else {
					$flags[ $parts[0] ] = false;
				}
			break;
		}
	} else {
		$parts = explode( ' ', $line, 6 );

		if ( count( $parts ) == 6 ) {
			$schedule_key = join( " ", array_slice( $parts, 0, 5 ) );
			$path = $parts[5];

			if ( ! isset( $schedule['schedule'][ $schedule_key ] ) ) {
				$schedule['schedule'][ $schedule_key ] = array(
					'content' => array(),
					'flags' => $flags,
				);
			}

			if ( preg_match( '/^(https?|ftp):/i', $path ) ) {
				$schedule['schedule'][ $schedule_key ]['content'][] = array(
					'url' => $path,
				);
			} else {
				if ( ! file_exists( add_base( $path ) ) ) {
					die( 'Path does not exist: ' . add_base( $path ) . " (" . $line . ")\n" );
				}

				if ( is_file( add_base( $path ) ) ) {
					$schedule['schedule'][ $schedule_key ]['content'][] = array(
						'file' => $path,
					);
				} else if ( is_dir( add_base( $path ) ) ) {
					$path = rtrim( $path, '/' ) . '/';

					$schedule['schedule'][ $schedule_key ]['content'][] = array(
						'dir' => $path,
					);
				} else {
					die( 'Path is neither a file nor a directory: ' . add_base( $path ) . "\n" );
				}
			}
		} else {
			die( 'Invalid formatting: ' . $line . "\n" );
		}
	}
}

foreach ( $schedule['schedule'] as $schedule_key => $schedule_data ) {
	foreach ( $schedule_data['content'] as $content ) {
		if ( isset( $content['file'] ) ) {
			index_file( add_base( $content['file'] ), $schedule['content_index'] );
		} else if ( isset( $content['dir'] ) ) {
			$files_in_dir = files_in_dir_deep( add_base( $content['dir'] ) );

			foreach ( $files_in_dir as $file_path ) {
				index_file( $file_path, $schedule['content_index'] );
			}
		}
	}

	if ( $schedule_data['flags']['ads'] ) {
		$files_in_dir = files_in_dir_deep( add_base( $schedule_data['flags']['ads'] ) );

		foreach ( $files_in_dir as $file_path ) {
			index_file( $file_path, $schedule['ad_index'], true );
		}
	}
}

// Reverse the schedule so that the first key encountered when looping through
// it is the last one that was entered, and therefore the one with the highest priority.
$schedule['schedule'] = array_reverse( $schedule['schedule'], true );

// Sort, mostly for ease of debugging.
ksort( $schedule['content_index'] );
ksort( $schedule['ad_index'] );

// Ensure that json_encode() formats these as objects.
if ( empty( $schedule['content_index'] ) ) {
	$schedule['content_index'] = new stdClass();
}

if ( empty( $schedule['ad_index'] ) ) {
	$schedule['ad_index'] = new stdClass();
}

file_put_contents( "programming.js", 'var programming = ' . json_encode( $schedule, JSON_PRETTY_PRINT ) . ';' );

echo "Done; programming schedule written to programming.js.\n";

/**
 * Index a given file and its metadata.
 */
function index_file( $file_path, &$index, $save_duration = false ) {
	global $base;
	global $existing_programming;

	if ( ! isset( $index[ $file_path ] ) ) {
		$content_data = new stdClass();

		$index_key = substr( $file_path, max( 0, strlen( $base ) - 1 ) );

		if ( $save_duration ) {
			$duration = existing_duration( $index_key );

			if ( ! $duration ) {
				$duration = get_duration( $file_path );
			}

			if ( $duration ) {
				$content_data->duration = $duration;
			}
		}

		$possible_caption_files = array(
			$file_path . ".vtt",
			preg_replace( '/\.[^\.]+$/', '.vtt', $file_path ),
		);

		foreach ( $possible_caption_files as $possible_caption_file ) {
			if ( file_exists( $possible_caption_file ) ) {
				$content_data->captions = substr( $possible_caption_file, max( 0, strlen( $base ) - 1 ) );
				break;
			}
		}

		$index[ $index_key ] = $content_data;
	}
}

/**
 * Find all files in a given directory, including files within subfolders (and their subfolders, etc.)
 */
function files_in_dir_deep( $dir ) {
	$files_and_dirs = glob( rtrim( $dir, '/' ) . '/' . "*" );

	$files = array();

	foreach ( $files_and_dirs as $file_or_dir ) {
		if ( file_exists( $file_or_dir ) ) {
			if ( is_file( $file_or_dir ) ) {
				$mime_type = mime_content_type( $file_or_dir );

				if ( stripos( $mime_type, 'video/' ) === 0 ) {
					$files[] = $file_or_dir;
				}
			} else {
				$files = array_merge( $files, files_in_dir_deep( $file_or_dir ) );
			}
		} else {
			echo "File does not exist: " . $file_or_dir . "\n";
		}
	}

	return $files;
}

/**
 * Find the duration in seconds of a given video file.
 *
 * @param string $file A file path.
 * @return int|bool Either the duration or false.
 */
function get_duration( $file ){
	$ffmpeg_output = shell_exec( "ffmpeg -i " . escapeshellarg( $file ) . " 2>&1" );

	preg_match( "/Duration: (.{2}):(.{2}):(.{2})(?:\.([^,]+))?,/", $ffmpeg_output, $duration );

	if ( ! isset( $duration[1] ) ) {
		return false;
	}

	$hours = $duration[1];
	$minutes = $duration[2];
	$seconds = $duration[3];
	$decimal = $duration[4];

	return floatval( ( $seconds + ( $minutes * 60 ) + ( $hours * 60 * 60 ) ) . "." . $decimal );
}

function add_base( $path ) {
	global $base;

	if ( ! $base ) {
		return $path;
	}

	$base = rtrim( $base, '/' ) . '/';

	return $base . ltrim( $path, '/' );
}