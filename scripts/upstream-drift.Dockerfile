# Sandbox image for the upstream drift trial. Everything that executes merged upstream code
# (npm install, build, check, tests, cargo) runs in a container from this image, so it cannot
# see the runner's processes, environment or token. Built from stdin: no build context.
FROM rust:1-bookworm@sha256:ade39a710ef85f3506cffcfec3e8a24ba090badef1dff2fb798f71d878833fea AS rust

FROM node:22-bookworm@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev fd-find ripgrep git ca-certificates \
	&& ln -s "$(command -v fdfind)" /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*
COPY --from=rust /usr/local/cargo /usr/local/cargo
COPY --from=rust /usr/local/rustup /usr/local/rustup
ENV RUSTUP_HOME=/usr/local/rustup \
	PATH=/usr/local/cargo/bin:$PATH
