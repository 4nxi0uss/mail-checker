test:
	docker ps

build:
	-docker image rm docker-cronjob-example
	docker build --no-cache -t docker-cronjob-example .

run:
	docker run -itd --rm --name my-cronjob docker-cronjob-example

stop:
	docker stop my-cronjob

check:
	docker logs -f my-cronjob

clean:
	docker stop my-cronjob
	docker rm my-cronjob
	docker image rm docker-cronjob-example
