import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Builds run from a separate .build worktree whose per-worktree HEAD can lag
// behind the source checkout. Read HEAD from Git's common directory so the
// game stamp always identifies the source repository revision.
const commonGitDir = execFileSync( 'git', [ 'rev-parse', '--git-common-dir' ], { encoding: 'utf8' } ).trim();
const commitSha = execFileSync( 'git', [ '--git-dir', resolve( commonGitDir ), 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim();
if ( ! /^[\da-f]{40}$/i.test( commitSha ) ) throw new Error( 'Git HEAD must be a full 40-character commit SHA' );
const commitShort = commitSha.slice( 0, 8 ).toLowerCase();

export default defineConfig( {
	// Relative asset paths let the client run at the GitHub Pages root and under /loz.
	base: './',
	resolve: { preserveSymlinks: true },
	plugins: [ {
		name: 'elsemesh-build-commit',
		transformIndexHtml( html ) {
			if ( ! html.includes( '%ELSEMESH_COMMIT%' ) ) throw new Error( 'Build commit placeholder is missing from index.html' );
			return html.replaceAll( '%ELSEMESH_COMMIT%', commitShort );
		},
	} ],
	build: { target: 'esnext', chunkSizeWarningLimit: 4000 },
	server: { port: 5188, strictPort: true, host: '127.0.0.1' },
} );
