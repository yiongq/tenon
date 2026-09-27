# A process tree for the stop and the timeout (spec 02 §点停止时各状态怎么收「执行命令」,
# §内置工具与参数「Bash」「超时」; plan step 23, 旧 7 and 旧 142): this shell and its child both
# ignore SIGTERM and hold the output pipe, so only the SIGKILL ends either of them. Each process
# prints `<role> <pid>` once it is set.
trap '' TERM
/bin/sh -c 'trap "" TERM; echo "child $$"; exec sleep 30' &
echo "parent $$"
wait
