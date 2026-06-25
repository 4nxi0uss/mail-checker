FROM ubuntu:24.04

# Install cron, curl, nodejs, npm
RUN apt-get update && \
    apt-get install -y cron curl nodejs npm tzdata && \
    rm -rf /var/lib/apt/lists/*

RUN ln -sf /usr/share/zoneinfo/Europe/Warsaw /etc/localtime && \
    echo "Europe/Warsaw" > /etc/timezone && \
    dpkg-reconfigure -f noninteractive tzdata

ENV TZ=Europe/Warsaw

# Copy package files and install dependencies
COPY ./package.json /package.json
RUN npm install

# Copy script and cron job
COPY ./container_cronjob /etc/cron.d/container_cronjob
COPY ./cron_script.sh /cron_script.sh
COPY ./monitor.js /monitor.js

# Set permissions
RUN chmod +x /cron_script.sh
RUN chmod 0644 /etc/cron.d/container_cronjob

# Start cron in foreground & keep container alive
CMD ["cron", "-f"]
